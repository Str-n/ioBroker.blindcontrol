const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, windowDefaults, parseConfig } = require('../build/lib/config');
const { RadiationTracker, radiationStateIds } = require('../build/lib/radiation');
const { clearSkyIrradiance, exposure, futureSunSamples } = require('../build/lib/solar');
const { prepareWeather, forecastMappings, forecastAt } = require('../build/lib/weather');
const { decide, newRuntime, atTime } = require('../build/lib/engine');
const now = new Date(2026, 6, 1, 12).getTime();
const sun = { azimuth: 180, elevation: 30 };
const cfg = (changes = {}) => parseConfig({ currentSunlightSource: 'radiation-first', ...changes });
const weather = { clouds: 80, cloudsSource: 'observed' };
function inputs(c = cfg(), factor = 0.9, time = now) {
    return new Map([
        [c.currentRadiationState, { val: clearSkyIrradiance(30) * factor, ts: time }],
        [c.radiationValidState, { val: true, ts: time }],
        [c.radiationLastSuccessState, { val: time, ts: time }],
        [c.radiationSourcesState, { val: '["pv","dwd"]', ts: time }],
        [c.radiationStatusState, { val: 'Multiple sources', ts: time }],
    ]);
}
const evaluate = (states = inputs(), c = cfg(), position = sun, time = now) =>
    new RadiationTracker().evaluate(time, states, c, position, weather);
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('radiation replaces current cloud attenuation while cloud mode remains unchanged', () => {
    const c = cfg();
    const result = evaluate();
    assert.equal(result.source, 'radiation');
    assert.equal(result.valid, true);
    close(result.factor, 0.9);
    close(exposure(sun, 80, windowDefaults, c, result.factor), Math.cos(Math.PI / 6) * 90);
    close(exposure(sun, 0, windowDefaults, c, result.factor), exposure(sun, 80, windowDefaults, c, result.factor));
    const legacy = evaluate(inputs(), cfg({ currentSunlightSource: 'clouds' }));
    assert.equal(legacy.reason, 'CLOUD_MODE');
    close(legacy.factor, 0.36);
    assert.deepEqual(radiationStateIds(defaults), []);
    assert(radiationStateIds(c).includes(c.radiationValidState));
});

test('generic lux sensors use explicit calibration without requiring model metadata', () => {
    const c = cfg({
        currentRadiationState: 'lux.sensor', radiationInputUnit: 'lux', radiationLuxPerWm2: 100,
        radiationValidState: '', radiationLastSuccessState: '', radiationSourcesState: '', radiationStatusState: '',
    });
    const result = evaluate(new Map([['lux.sensor', { val: clearSkyIrradiance(30) * 50, ts: now }]]), c);
    close(result.factor, 0.5);
    close(result.irradiance, clearSkyIrradiance(30) * 0.5);
    assert.deepEqual(radiationStateIds(c), ['lux.sensor']);
});

test('zero radiation is valid and enhanced radiation is bounded to the exposure scale', () => {
    const c = cfg();
    const dark = evaluate(inputs(c, 0));
    assert.equal(dark.valid, true);
    assert.equal(dark.factor, 0);
    const bright = inputs(c);
    bright.set(c.currentRadiationState, { val: 1600, ts: now });
    assert.equal(evaluate(bright).factor, 1);
});

test('low sun and twilight never divide by a near-zero clear-sky estimate', () => {
    for (const elevation of [-8, 0, 0.1, 4.99]) {
        const result = evaluate(inputs(), cfg(), { ...sun, elevation });
        assert.equal(result.reason, 'LOW_SUN');
        assert.equal(result.normalizedFactor, null);
        close(result.factor, 0.36);
    }
    assert.equal(clearSkyIrradiance(0), 0);
    const result = new RadiationTracker().evaluate(now, inputs(), cfg(), undefined, weather);
    assert.equal(result.reason, 'SUN_UNAVAILABLE');
});

for (const [name, signal] of [
    ['missing', undefined], ['null', { val: null, ts: now }], ['negative', { val: -1, ts: now }],
    ['non-numeric', { val: 'bright', ts: now }], ['infinite', { val: Infinity, ts: now }],
    ['out of range', { val: 1601, ts: now }], ['stale', { val: 100, ts: now - 26 * 60000 }],
    ['future', { val: 100, ts: now + 61000 }], ['bad quality', { val: 100, ts: now, q: 1 }],
]) test(`invalid radiation (${name}) falls back without disabling the controller`, () => {
    const c = cfg(), states = inputs(c);
    if (signal) states.set(c.currentRadiationState, signal);
    else states.delete(c.currentRadiationState);
    const result = evaluate(states, c);
    assert.equal(result.reason, 'INVALID_RADIATION');
    assert.equal(result.source, 'clouds');
    assert.equal(result.valid, false);
    close(result.factor, 0.36);
});

test('validity, last-success and source metadata must be fresh and well formed', () => {
    const c = cfg();
    for (const [key, value, reason] of [
        ['radiationValidState', { val: false, ts: now }, 'PRODUCER_INVALID'],
        ['radiationValidState', { val: true, ts: now, q: 1 }, 'INVALID_VALIDITY'],
        ['radiationLastSuccessState', { val: now - 26 * 60000, ts: now }, 'INVALID_LAST_SUCCESS'],
        ['radiationLastSuccessState', { val: now + 61000, ts: now }, 'INVALID_LAST_SUCCESS'],
        ['radiationSourcesState', { val: '{}', ts: now }, 'INVALID_SOURCES'],
        ['radiationSourcesState', { val: '[1]', ts: now }, 'INVALID_SOURCES'],
        ['radiationStatusState', { val: null, ts: now }, 'INVALID_STATUS'],
    ]) {
        const states = inputs(c);
        states.set(c[key], value);
        const result = evaluate(states, c);
        assert.equal(result.reason, reason);
        assert.equal(result.source, 'clouds');
    }
});

test('cloud-only estimates are labelled fallback; clipped and unverified estimates only strengthen clouds', () => {
    const c = cfg();
    for (const [sources, status, quality] of [
        ['["pv"]', 'PV clipping; lower-bound fallback', 'lower-bound'],
        ['["satellite"]', 'Single source; unverified', 'unverified'],
        ['[]', 'Modelled twilight', 'unverified'],
    ]) {
        for (const factor of [0.1, 0.9]) {
            const states = inputs(c, factor);
            states.set(c.radiationSourcesState, { val: sources, ts: now });
            states.set(c.radiationStatusState, { val: status, ts: now });
            const result = evaluate(states, c);
            assert.equal(result.quality, quality);
            assert.equal(result.source, 'radiation-conservative');
            close(result.factor, Math.max(0.36, factor));
        }
    }
    const states = inputs(c, 0.1);
    states.set(c.radiationSourcesState, { val: '["openweather"]', ts: now });
    const result = evaluate(states, c);
    assert.equal(result.reason, 'CLOUD_ONLY_FALLBACK');
    assert.equal(result.source, 'clouds');
    close(result.factor, 0.36);
});

test('producer refresh retains only the completed snapshot, with bounded non-renewable grace', () => {
    const c = cfg(), states = inputs(c), tracker = new RadiationTracker();
    close(tracker.evaluate(now, states, c, sun, weather).factor, 0.9);
    states.set(c.radiationValidState, { val: false, ts: now + 1000 });
    states.set(c.currentRadiationState, { val: 0, ts: now + 2000 });
    let result = tracker.evaluate(now + 2000, states, c, sun, weather);
    assert.equal(result.refreshing, true);
    close(result.factor, 0.9);
    assert.equal(result.sampleTime, now, 'retained data must not look newer');
    assert.equal(result.retryAt, now + 31000);
    states.set(c.radiationValidState, { val: false, ts: now + 29000 });
    result = tracker.evaluate(now + 29000, states, c, sun, weather);
    assert.equal(result.retryAt, now + 31000);
    result = tracker.evaluate(now + 31000, states, c, sun, weather);
    assert.equal(result.source, 'clouds');
    assert.equal(result.valid, false);
    // No cached history on a restart during publication.
    assert.equal(evaluate(states, c, sun, now + 30000).source, 'clouds');
    const complete = inputs(c, 0.1, now + 32000);
    result = tracker.evaluate(now + 32000, complete, c, sun, weather);
    close(result.factor, 0.1);
    assert.equal(result.refreshing, false);
});

test('refresh grace cannot extend the original freshness deadline', () => {
    const c = cfg({ radiationMaxAge: 1 }), states = inputs(c), tracker = new RadiationTracker();
    tracker.evaluate(now, states, c, sun, weather);
    states.set(c.radiationValidState, { val: false, ts: now + 50000 });
    const result = tracker.evaluate(now + 50000, states, c, sun, weather);
    assert.equal(result.retryAt, now + 60000);
    assert.equal(tracker.evaluate(now + 60000, states, c, sun, weather).source, 'clouds');
});

test('new fields with an older completion flag are not accepted as a completed publication', () => {
    const c = cfg(), states = inputs(c), tracker = new RadiationTracker();
    tracker.evaluate(now, states, c, sun, weather);
    states.set(c.currentRadiationState, { val: 0, ts: now + 1000 });
    const result = tracker.evaluate(now + 1000, states, c, sun, weather);
    assert.equal(result.refreshing, true);
    close(result.factor, 0.9);
    assert.equal(evaluate(states, c, sun, now + 1000).reason, 'INCOMPLETE_PUBLICATION');
});

test('temperature forecasts remain usable without any cloud states and do not invent future exposure', () => {
    const c = cfg(), states = new Map();
    for (const [i, m] of forecastMappings(c).slice(0, 9).entries()) {
        states.set(m.timeState, { val: now + i * 3 * 3600000, ts: now });
        states.set(m.temperatureState, { val: 32, ts: now });
    }
    const prepared = prepareWeather(now, states, c);
    assert.equal(prepared.valid, true);
    assert.equal(prepared.forecastCloudsValid, false);
    assert.equal(prepared.cloudsSource, 'clear-sky-fallback');
    assert.equal(prepared.outside, 32);
    const futureSuns = futureSunSamples(now, 3, 51, 7,
        (time) => forecastAt(prepared.interpolationPoints, time)?.clouds);
    assert.deepEqual(futureSuns, []);
    const r = evaluate(inputs(c, 1), c);
    const decision = decide({
        now, enabled: true, pauseToday: false, vacationMode: false, dryRun: false, windowEnabled: true,
        position: 100, roomTemperature: 28, sun, weather: prepared, futureSuns,
        currentSunlightFactor: r.factor, contactValid: true, vacationCloseTime: atTime(now, '21:00'),
    }, { ...windowDefaults }, c, newRuntime());
    assert.equal(decision.move, true);
    assert.equal(decision.effectiveTargetPosition, 0);
    for (const m of forecastMappings(c)) states.delete(m.temperatureState);
    assert.equal(prepareWeather(now, states, c).valid, false, 'radiation cannot replace a temperature forecast');
});

test('missing one cloud value preserves temperature interpolation but leaves that cloud interval unknown', () => {
    const result = forecastAt([
        { time: now, temperature: 30, clouds: 0 },
        { time: now + 3 * 3600000, temperature: 24 },
    ], now + 1.5 * 3600000);
    assert.equal(result.temperature, 27);
    assert.equal(result.clouds, undefined);
});

test('radiation configuration validates units, ranges and optional cloud mappings', () => {
    for (const changes of [
        { currentSunlightSource: 'unknown' }, { currentRadiationState: '' },
        { radiationInputUnit: 'watts' }, { radiationLuxPerWm2: 0 }, { radiationMaxAge: 0 },
        { radiationRefreshGraceSeconds: 121 }, { radiationMinSunElevation: 0 },
        { radiationValidState: true },
    ]) assert.throws(() => cfg(changes));
    assert.equal(cfg({ weatherProvider: 'custom', forecastMapping: [{ timeState: 'time', temperatureState: 'temp' }] })
        .forecastMapping[0].cloudsState, undefined);
});

test('low current radiation does not cancel predictive shading on a very hot day', () => {
    const c = cfg();
    const prepared = {
        ...weather, valid: true, risk: 95, points: [], interpolationPoints: [], outside: 33,
    };
    const input = {
        now, enabled: true, pauseToday: false, vacationMode: false, dryRun: false, windowEnabled: true,
        position: 100, roomTemperature: 28, sun, weather: prepared, currentSunlightFactor: 0,
        contactValid: true, vacationCloseTime: atTime(now, '21:00'), futureSuns: [],
    };
    assert.equal(decide(input, windowDefaults, c, newRuntime()).effectiveTargetPosition, 100);
    const decision = decide({ ...input, futureSuns: [{ sun, clouds: 0 }] }, windowDefaults, c, newRuntime());
    assert.equal(decision.solarExposure, 0);
    assert.equal(decision.effectiveTargetPosition, 0);
    assert.equal(decision.move, true);
});
