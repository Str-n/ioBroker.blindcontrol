const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, windowDefaults, parseConfig } = require('../build/lib/config');
const {
    decide,
    newRuntime,
    localDate,
    atTime,
    pauseExpired,
    observePosition,
    hysteresis,
} = require('../build/lib/engine');
const { prepareWeather, forecastMappings, forecastAt, numeric, interpolate } = require('../build/lib/weather');
const { exposure, solarPosition, futureSunSamples } = require('../build/lib/solar');
const now = new Date(2026, 6, 1, 12).getTime();
const c = () => structuredClone(defaults);
const w = () => ({
    ...windowDefaults,
    id: 'south',
    name: 'South',
    blindSetState: 'blind.set',
    blindActualState: 'blind.actual',
    roomTemperatureState: 'room.temp',
});
const weather = () => ({
    valid: true,
    risk: 95,
    max: 34,
    min: 23,
    heatLoad: 140,
    coolingHours: 0,
    outside: 33,
    clouds: 0,
    points: [{ time: now + 3 * 3600000, temperature: 33, clouds: 0 }],
});
const input = () => ({
    now,
    enabled: true,
    pauseToday: false,
    vacationMode: false,
    dryRun: false,
    windowEnabled: true,
    position: 100,
    roomTemperature: 28,
    contactValid: true,
    contactOpen: false,
    sun: { azimuth: 180, elevation: 50 },
    weather: weather(),
    futureSuns: [],
    vacationCloseTime: atTime(now, '21:00'),
});
const run = (i = {}, win = {}, runtime = {}, config = {}) =>
    decide({ ...input(), ...i }, { ...w(), ...win }, { ...c(), ...config }, { ...newRuntime(), ...runtime });

for (const [label, changes, reason] of [
    ['global disable', { enabled: false }, 'GLOBAL_DISABLED'],
    ['pause today', { pauseToday: true }, 'PAUSED_TODAY'],
    ['window disable', { windowEnabled: false }, 'WINDOW_DISABLED'],
    ['invalid forecast', { weather: { ...weather(), valid: false } }, 'INVALID_FORECAST'],
    ['missing room temperature', { roomTemperature: undefined }, 'INVALID_ROOM_TEMPERATURE'],
    ['missing sun', { sun: undefined }, 'INVALID_SUN_POSITION'],
    ['NaN sun', { sun: { azimuth: NaN, elevation: 30 } }, 'INVALID_SUN_POSITION'],
    ['missing blind position', { position: undefined }, 'INVALID_BLIND_POSITION'],
    ['out of range position', { position: 101 }, 'INVALID_BLIND_POSITION'],
])
    test(label, () => {
        const d = run(changes);
        assert.equal(d.move, false);
        assert.equal(d.blockedReason, reason);
    });

test('priority: global disable precedes invalid data and window disable', () =>
    assert.equal(
        run({ enabled: false, weather: { valid: false }, windowEnabled: false }).blockedReason,
        'GLOBAL_DISABLED',
    ));
test('pause resets by local date, including year transition and restart', () => {
    const before = new Date(2026, 11, 31, 23, 59).getTime(),
        after = new Date(2027, 0, 1, 0, 0).getTime();
    assert.equal(pauseExpired(true, localDate(before), before), false);
    assert.equal(pauseExpired(true, localDate(before), after), true);
});
test('normal 60 minute cooldown survives serialized runtime', () => {
    const r = JSON.parse(JSON.stringify({ ...newRuntime(), lastAutoAction: now - 59 * 60000 }));
    assert.equal(run({}, {}, r, { emergencyEnabled: false }).blockedReason, 'MIN_MOVEMENT_INTERVAL');
    assert.equal(run({}, {}, { ...r, lastAutoAction: now - 60 * 60000 }, { emergencyEnabled: false }).move, true);
});
test('manual action recognised and held for full hour, including emergency', () => {
    const r = newRuntime();
    assert.equal(observePosition(r, 50, 100, now, c()), 'manual');
    assert.equal(run({ now: now + 59 * 60000 }, {}, r).blockedReason, 'MANUAL_HOLD');
    assert.equal(run({ now: now + 60 * 60000 }, {}, r).move, true);
});
test('manual hold persists at low exposure beyond its deadline', () => {
    const r = newRuntime();
    observePosition(r, 50, 100, now - 7200000, c());
    assert.equal(run({ sun: { azimuth: 0, elevation: 30 } }, {}, r).blockedReason, 'MANUAL_HOLD');
});
test('own trajectory is recognised, completed target does not hide later opposite movement', () => {
    const r = {
        ...newRuntime(),
        commandId: 'a',
        commandTimestamp: now,
        commandStartPosition: 100,
        targetPosition: 0,
    };
    assert.equal(observePosition(r, 100, 75, now + 1000, c()), 'automatic');
    assert.equal(observePosition(r, 75, 0, now + 2000, c()), 'automatic');
    assert.equal(observePosition(r, 0, 2, now + 3000, c()), 'unchanged');
    assert.equal(observePosition(r, 0, 50, now + 4000, c()), 'manual');
});
test('different command, wrong direction, and late response are manual', () => {
    const pending = () => ({
        ...newRuntime(),
        commandId: 'a',
        commandTimestamp: now,
        commandStartPosition: 100,
        targetPosition: 25,
    });
    assert.equal(observePosition(pending(), 75, 50, now + 1000, c(), true), 'manual');
    assert.equal(observePosition(pending(), 50, 80, now + 1000, c()), 'manual');
    assert.equal(observePosition(pending(), 50, 25, now + 121000, c()), 'manual');
});
test('emergency only shortens cooldown for closing after 15 minutes', () => {
    assert.equal(run({}, {}, { lastAutoAction: now - 14 * 60000 }).blockedReason, 'MIN_MOVEMENT_INTERVAL');
    assert.equal(run({}, {}, { lastAutoAction: now - 15 * 60000 }).decisionReason, 'EMERGENCY_HEAT_PROTECTION');
    const d = run(
        { position: 0, sun: { azimuth: 0, elevation: 50 } },
        {},
        { lastAutoAction: now - 20 * 60000, managedDate: localDate(now) },
    );
    assert.equal(d.move, false);
    assert.equal(d.blockedReason, 'MIN_MOVEMENT_INTERVAL');
});
test('open contact blocks closing even for vacation and emergency', () => {
    for (const vacationMode of [false, true])
        assert.equal(
            run({ contactOpen: true, vacationMode, vacationCloseTime: now - 1 }, { contactState: 'contact' })
                .blockedReason,
            'CONTACT_OPEN',
        );
});
test('invalid contact is fail safe; ignore contact bypasses invalid data', () => {
    assert.equal(run({ contactValid: false }, { contactState: 'contact' }).blockedReason, 'INVALID_CONTACT');
    assert.equal(run({ contactValid: false }, { contactState: 'contact', contactMode: 'ignore' }).move, true);
});
test('force-open safety position never closes an already more open blind', () => {
    assert.equal(
        run(
            { position: 50, contactOpen: true },
            {
                contactState: 'contact',
                contactMode: 'forceOpenWhileOpen',
                safetyPosition: 75,
            },
        ).effectiveTargetPosition,
        75,
    );
    assert.equal(
        run(
            { position: 100, contactOpen: true },
            {
                contactState: 'contact',
                contactMode: 'forceOpenWhileOpen',
                safetyPosition: 75,
            },
        ).move,
        false,
    );
});
test('very hot south window closes fully, moderate weather preserves daylight', () => {
    assert.equal(run().effectiveTargetPosition, 0);
    assert.equal(run({ roomTemperature: 21, weather: { ...weather(), risk: 30 } }).effectiveTargetPosition, 75);
});
test('west window may close fully; future sun matters only at high heat', () => {
    const futureSuns = [{ sun: { azimuth: 270, elevation: 50 }, clouds: 0 }];
    assert.equal(run({ sun: { azimuth: 270, elevation: 20 } }, { windowAzimuth: 270 }).effectiveTargetPosition, 0);
    assert(
        run({ futureSuns, sun: { azimuth: 90, elevation: 50 } }, { windowAzimuth: 270 }).effectiveTargetPosition < 100,
    );
    assert.equal(
        run(
            {
                futureSuns,
                roomTemperature: 21,
                weather: { ...weather(), risk: 0 },
                sun: { azimuth: 90, elevation: 50 },
            },
            { windowAzimuth: 270 },
        ).effectiveTargetPosition,
        100,
    );
});
test('hysteresis resists cloud fluctuations and heat-band threshold jitter', () => {
    assert.equal(hysteresis(44, [25, 45, 65, 85], 2, 5), 2);
    assert.equal(hysteresis(39, [25, 45, 65, 85], 2, 5), 1);
    assert.equal(hysteresis(74, [30, 55, 75], 3, 5), 3);
    assert.equal(run({}, {}, { lastAutoAction: now - 60000 }, { emergencyEnabled: false }).move, false);
});
test('evening cooling opens exactly one step from 25 to 50', () => {
    const evening = atTime(now, '18:00');
    const d = run(
        {
            now: evening,
            position: 25,
            roomTemperature: 24,
            sun: { azimuth: 240, elevation: 30 },
            weather: {
                ...weather(),
                outside: 30,
                points: [{ time: evening + 3 * 3600000, temperature: 27, clouds: 0 }],
            },
        },
        {},
        { managedDate: localDate(now) },
        { openingStabilityMinutes: 0 },
    );
    assert.equal(d.effectiveTargetPosition, 50);
    assert.equal(d.decisionReason, 'EVENING_RELAXATION');
    assert.equal(d.move, true);
});
test('normal morning opt-out prevents generic heat logic opening closed bedroom', () => {
    assert.equal(run({ position: 0, sun: { azimuth: 0, elevation: 30 } }).blockedReason, 'MORNING_OPEN_DISABLED');
    assert.equal(
        run({ position: 0, sun: { azimuth: 0, elevation: 30 } }, { autoOpenMorning: true }).decisionReason,
        'MORNING_OPEN',
    );
});
test('vacation morning overrides opt-out and caps opening for heat', () => {
    const d = run({
        position: 0,
        vacationMode: true,
        roomTemperature: 21,
        weather: { ...weather(), risk: 30 },
    });
    assert.equal(d.decisionReason, 'VACATION_MORNING_OPEN');
    assert.equal(d.effectiveTargetPosition, 75);
    assert.equal(d.move, true);
});
test('earliest-open restriction applies to ordinary and safety opening', () => {
    const early = atTime(now, '06:30');
    const d = run(
        { now: early, position: 0, contactOpen: true },
        { contactState: 'contact', contactMode: 'forceOpenWhileOpen' },
    );
    assert.equal(d.blockedReason, 'EARLIEST_OPEN_NOT_REACHED');
    assert.equal(run({ now: early }).move, true);
});
test('vacation closes outside control time and retries after manual hold', () => {
    const late = atTime(now, '23:00');
    const d = run({ now: late, vacationMode: true });
    assert.equal(d.move, true);
    assert.equal(d.decisionReason, 'VACATION_EVENING_CLOSE');
    assert.equal(
        run(
            { now: late, vacationMode: true },
            {},
            {
                lastManualAction: late - 60000,
                manualHoldUntil: late + 3540000,
                manualPosition: 100,
            },
        ).blockedReason,
        'MANUAL_HOLD',
    );
    assert.equal(run({ now: late }).blockedReason, 'OUTSIDE_CONTROL_TIME');
});
test('minimum change and dry-run do not move, but dry-run keeps target and reason', () => {
    assert.equal(run({ position: 5 }).blockedReason, 'POSITION_CHANGE_TOO_SMALL');
    const d = run({ dryRun: true });
    assert.equal(d.move, false);
    assert.equal(d.effectiveTargetPosition, 0);
    assert.notEqual(d.decisionReason, 'NONE');
});
test('solar model uses azimuth, optional wrapped bounds, elevation and continuous clouds', () => {
    assert(exposure({ azimuth: 180, elevation: 45 }, 80, w(), c()) > 0);
    assert.equal(exposure({ azimuth: 180, elevation: -1 }, 0, w(), c()), 0);
    const north = {
        ...w(),
        windowAzimuth: 0,
        sunAzimuthMin: 330,
        sunAzimuthMax: 30,
    };
    assert(exposure({ azimuth: 355, elevation: 20 }, 0, north, c()) > 0);
    assert.equal(exposure({ azimuth: 90, elevation: 20 }, 0, north, c()), 0);
    const sun = solarPosition(Date.UTC(2026, 5, 21, 12), 51, 0);
    assert(Math.abs(sun.azimuth - 180) < 3);
    assert(sun.elevation > 60);
});
function forecast(nightTemperature, overrides = {}) {
    const cfg = { ...c(), ...overrides },
        states = new Map();
    forecastMappings(cfg)
        .slice(0, 8)
        .forEach((m, i) => {
            const time = now + i * 3 * 3600000;
            const hour = new Date(time).getHours();
            const temp = hour >= 22 || hour < 7 ? nightTemperature : 25;
            for (const [id, val] of [
                [m.timeState, time],
                [m.temperatureState, temp],
                [m.cloudsState, 10],
            ])
                states.set(id, { val, ts: now });
        });
    return { cfg, states, result: prepareWeather(now, states, cfg) };
}
test('same daytime max with warm night has greater load and risk than cool night', () => {
    const cool = forecast(10).result,
        warm = forecast(20).result;
    assert.equal(cool.valid, true);
    assert.equal(warm.valid, true);
    assert.equal(cool.max, warm.max);
    assert(warm.risk > cool.risk + 20);
    assert(cool.coolingHours > 0);
});
test('forecast uses dates rather than period indices, rejects stale/incomplete data', () => {
    const { cfg, states } = forecast(20);
    const mappings = forecastMappings(cfg);
    states.set(mappings[0].timeState, { val: now - 4 * 3600000, ts: now });
    assert(prepareWeather(now, states, cfg).points.every((p) => p.time >= now));
    for (const state of states.values()) state.ts = now - 7 * 3600000;
    assert.equal(prepareWeather(now, states, cfg).valid, false);
    assert.equal(prepareWeather(now, new Map(), cfg).valid, false);
});
test('custom forecast maps states and numeric input checks type, age and quality', () => {
    const mapping = forecastMappings(c()).map((_, i) => ({
        timeState: `custom.${i}.time`,
        temperatureState: `custom.${i}.temp`,
        cloudsState: `custom.${i}.cloud`,
    }));
    assert.equal(forecast(20, { weatherProvider: 'custom', forecastMapping: mapping }).result.valid, true);
    assert.equal(numeric({ val: null, ts: now }, now, 60), undefined);
    assert.equal(numeric({ val: 20, ts: now, q: 1 }, now, 60), undefined);
    assert.equal(
        interpolate(22.5, [
            { x: 20, y: 0 },
            { x: 25, y: 50 },
        ]),
        25,
    );
});
test('configuration rejects unsafe arrays, duplicate output and IDs', () => {
    assert.throws(() => parseConfig({ windows: [w(), w()] }));
    assert.throws(() => parseConfig({ minPositionChange: 0 }));
    assert.throws(() => parseConfig({ shadeLevels: [] }));
    assert.throws(() => parseConfig({ heatRiskThresholds: [75, 55, 30] }));
    assert.throws(() => parseConfig({ controlStart: '25:00' }));
    assert.equal(parseConfig({ windows: [w()] }).windows[0].id, 'south');
});

test('OpenWeatherMap preset maps to states returned by the real adapter search', () => {
    const ids = new Set(require('./fixtures/openweathermap-forecast-state-ids.json'));
    const mapping = forecastMappings(c());
    assert.equal(mapping.length, 40);
    for (const point of mapping) {
        for (const id of Object.values(point)) assert(ids.has(id), `Missing forecast state: ${id}`);
        assert(point.temperatureState.endsWith('.temperatureMax'));
    }
    assert.equal(
        forecastMappings({ ...c(), openWeatherMapInstance: 'openweathermap.7' })[0].temperatureState,
        'openweathermap.7.forecast.period0.temperatureMax',
    );
});

test('OpenWeatherMap forecast uses per-period maximum temperatures without a temperature state', () => {
    const states = new Map();
    for (let i = 0; i < 8; i++) {
        const prefix = `openweathermap.0.forecast.period${i}`;
        states.set(`${prefix}.date`, { val: now + i * 3 * 3600000, ts: now });
        states.set(`${prefix}.temperatureMax`, { val: 25 + i, ts: now });
        states.set(`${prefix}.temperatureMin`, { val: 10 + i, ts: now });
        states.set(`${prefix}.clouds`, { val: 20, ts: now });
    }
    const result = prepareWeather(now, states, c());
    assert.equal(result.valid, true);
    assert.deepEqual(
        result.points.map((p) => p.temperature),
        [25, 26, 27, 28, 29, 30, 31, 32],
    );
    assert.equal(result.max, 32);
    assert.equal(result.min, 25);
    assert.equal(result.outside, 25);
    assert.equal(result.heatLoad, 156);
    // Custom mappings remain explicit; they may intentionally use the minimum.
    const custom = {
        ...c(),
        weatherProvider: 'custom',
        forecastMapping: Array.from({ length: 8 }, (_, i) => ({
            timeState: `openweathermap.0.forecast.period${i}.date`,
            temperatureState: `openweathermap.0.forecast.period${i}.temperatureMin`,
            cloudsState: `openweathermap.0.forecast.period${i}.clouds`,
        })),
    };
    assert.deepEqual(
        prepareWeather(now, states, custom).points.map((p) => p.temperature),
        [10, 11, 12, 13, 14, 15, 16, 17],
    );
});

function rememberDecision(r, d) {
    for (const key of ['heatBand', 'shadeLevel', 'thermalActive', 'roomOverheated', 'openingSince', 'openingTarget', 'openingLastEvaluation'])
        r[key] = d[key];
}

test('evening relaxation converges to a stable target and never cycles back from fully open', () => {
    const evening = atTime(now, '17:00');
    const r = { ...newRuntime(), managedDate: localDate(now) };
    let position = 25;
    for (let hour = 0; hour < 5; hour++) {
        const time = evening + hour * 3600000;
        const d = run({
            now: time, position, roomTemperature: 24,
            sun: { azimuth: 270, elevation: 35 },
            weather: { ...weather(), outside: 33, points: [{ time: time + 3 * 3600000, temperature: 29, clouds: 0 }] },
        }, { windowAzimuth: 270 }, r, { openingStabilityMinutes: 0 });
        assert.equal(d.effectiveTargetPosition, 50);
        assert.equal(d.move, hour === 0);
        if (d.move) { position = d.effectiveTargetPosition; r.lastAutoAction = time; }
        rememberDecision(r, d);
    }
    const d = run({
        now: evening, position: 100, roomTemperature: 24, sun: { azimuth: 270, elevation: 35 },
        weather: { ...weather(), outside: 33, points: [{ time: evening + 3 * 3600000, temperature: 29, clouds: 0 }] },
    }, { windowAzimuth: 270 });
    assert.equal(d.effectiveTargetPosition, 50, 'fully open uses the same relaxed target');
});

test('a brief cloud never opens the blind or starts a closing cooldown', () => {
    const r = { ...newRuntime(), managedDate: localDate(now), heatBand: 1, shadeLevel: 2 };
    const cloud = run({ position: 50, roomTemperature: 24, weather: { ...weather(), risk: 40, clouds: 100 } }, {}, r);
    assert.equal(cloud.effectiveTargetPosition, 100);
    assert.equal(cloud.blockedReason, 'OPENING_NOT_STABLE');
    rememberDecision(r, cloud);
    const sun = run({ now: now + 5 * 60000, position: 50 }, {}, r);
    assert.equal(sun.move, true, 'renewed heat protection remains possible immediately');
    assert.equal(sun.effectiveTargetPosition, 0);
    assert.equal(sun.openingSince, 0);
});

test('ordinary opening requires continuous stable evaluations and resets on interruptions', () => {
    const r = { ...newRuntime(), managedDate: localDate(now) };
    const changes = { position: 50, roomTemperature: 19, weather: { ...weather(), risk: 0 } };
    for (let minute = 0; minute <= 20; minute += 5) {
        const d = run({ ...changes, now: now + minute * 60000 }, {}, r);
        assert.equal(d.move, minute === 20);
        if (minute < 20) assert.equal(d.blockedReason, 'OPENING_NOT_STABLE');
        rememberDecision(r, d);
    }
    const stale = run({ ...changes, now: now + 40 * 60000 }, {}, r);
    assert.equal(stale.blockedReason, 'OPENING_NOT_STABLE');
    assert.equal(stale.openingSince, now + 40 * 60000);
    for (const interrupted of [{ enabled: false }, { pauseToday: true }, { weather: { ...weather(), valid: false } }]) {
        const d = run({ ...changes, ...interrupted }, {}, r);
        assert.equal(d.openingSince, 0);
    }
});

test('an abrupt increase in the proposed opening must establish its own stability', () => {
    const d = run({ position: 25, roomTemperature: 19, weather: { ...weather(), risk: 0 } }, {}, {
        managedDate: localDate(now), openingSince: now - 30 * 60000,
        openingLastEvaluation: now - 5 * 60000, openingTarget: 50,
    });
    assert.equal(d.effectiveTargetPosition, 100);
    assert.equal(d.blockedReason, 'OPENING_NOT_STABLE');
    assert.equal(d.openingSince, now);
});

test('thermal activation preserves daylight when cool and has a separate release hysteresis', () => {
    const cold = run({ roomTemperature: 19, weather: { ...weather(), risk: 0 } });
    assert.equal(cold.effectiveTargetPosition, 100);
    assert.equal(cold.move, false);
    assert.equal(cold.decisionReason, 'NO_THERMAL_DEMAND');
    const r = newRuntime();
    for (const [risk, active] of [[30, true], [22, true], [20, false]]) {
        const d = run({ roomTemperature: 19, weather: { ...weather(), risk } }, {}, r);
        assert.equal(d.thermalActive, active);
        rememberDecision(r, d);
    }
});

test('measured overheating enforces shading and emergency closing despite a cool forecast', () => {
    const d = run({ roomTemperature: 30, weather: { ...weather(), risk: 0 } }, {}, {
        heatBand: 0, lastAutoAction: now - 16 * 60000,
    });
    assert(d.heatRisk >= 90);
    assert.equal(d.heatBand, 3);
    assert.equal(d.effectiveTargetPosition, 0);
    assert.equal(d.decisionReason, 'EMERGENCY_HEAT_PROTECTION');
    assert.equal(d.move, true);
    assert.equal(run({ roomTemperature: 30, weather: { ...weather(), risk: 0 } }, {}, {
        lastAutoAction: now - 16 * 60000,
    }, { emergencyEnabled: false }).blockedReason, 'MIN_MOVEMENT_INTERVAL');
});

test('room overheating has temperature hysteresis and respects the configured sensor offset', () => {
    const r = newRuntime();
    for (const [roomTemperature, overheated] of [[25, true], [24.7, true], [24.4, false]]) {
        const d = run({ roomTemperature, weather: { ...weather(), risk: 0 } }, { temperatureOffset: 1 }, r);
        assert.equal(d.roomOverheated, overheated);
        if (overheated) assert(d.heatRisk >= 75);
        rememberDecision(r, d);
    }
});

test('vertical-window geometry protects low east/west sun and attenuates at the horizon', () => {
    const west = { ...w(), windowAzimuth: 270 };
    const low = exposure({ azimuth: 270, elevation: 8 }, 0, west, c());
    assert(low > 65, 'low direct sun still needs substantial shading');
    assert(exposure({ azimuth: 270, elevation: 80 }, 0, west, c()) < low);
    assert(exposure({ azimuth: 270, elevation: 0.1 }, 0, west, c()) < 2);
    assert.equal(exposure({ azimuth: 90, elevation: 8 }, 0, west, c()), 0);
    const d = run({ position: 25, sun: { azimuth: 270, elevation: 8 } }, west, {
        managedDate: localDate(now), heatBand: 3, shadeLevel: 3,
    });
    assert(d.effectiveTargetPosition <= 25);
    const east = run({ sun: { azimuth: 90, elevation: 15 } }, { windowAzimuth: 90 });
    assert.equal(east.effectiveTargetPosition, 0);
});

test('later scheduled events release extended manual holds, including after sunset', () => {
    const evening = atTime(now, '22:00');
    const d = run({ now: evening, vacationMode: true, sun: { azimuth: 320, elevation: -5 } }, {}, {
        lastManualAction: evening - 3 * 3600000, manualHoldUntil: evening - 2 * 3600000,
        manualPosition: 100, manualDirection: 1,
    });
    assert.equal(d.move, true);
    assert.equal(d.decisionReason, 'VACATION_EVENING_CLOSE');
    const morning = atTime(now, '07:00');
    const r = {
        lastManualAction: morning - 9 * 3600000, manualHoldUntil: morning - 8 * 3600000,
        manualPosition: 0, manualDirection: -1,
    };
    const opened = run({ now: morning, position: 0, sun: { azimuth: 80, elevation: 15 } }, { autoOpenMorning: true }, r);
    assert.equal(opened.move, true);
    assert.equal(opened.effectiveTargetPosition, 100);
    assert.equal(run({ now: morning, position: 0 }, { autoOpenMorning: true }, {
        ...r, lastManualAction: morning - 30 * 60000, manualHoldUntil: morning + 30 * 60000,
    }).blockedReason, 'MANUAL_HOLD');
});

test('manual closing preserves privacy in sunshine and is not undone by an earlier pending morning event', () => {
    const r = {
        lastManualAction: now - 2 * 3600000, manualHoldUntil: now - 3600000,
        manualPosition: 0, manualDirection: -1, managedDate: localDate(now),
    };
    for (const morningDate of ['', localDate(now)]) {
        const d = run({ position: 0, roomTemperature: 19, weather: { ...weather(), risk: 0 } },
            { autoOpenMorning: true }, { ...r, morningDate });
        assert.equal(d.move, false);
        assert.equal(d.blockedReason, 'MANUAL_CLOSED');
    }
});

test('persistent keepClosed blocks scheduled opening, but contact safety retains its minimum guards', () => {
    const opening = { position: 0, keepClosed: true, sun: { azimuth: 0, elevation: 30 } };
    assert.equal(run(opening, { autoOpenMorning: true }).blockedReason, 'KEEP_CLOSED');
    const contactWindow = { contactState: 'contact', contactMode: 'forceOpenWhileOpen' };
    assert.equal(run({ ...opening, contactOpen: true }, contactWindow).move, true);
    assert.equal(run({ ...opening, contactOpen: true }, contactWindow, {
        lastManualAction: now - 60000, manualHoldUntil: now + 59 * 60000, manualPosition: 0,
    }).blockedReason, 'MANUAL_HOLD');
    assert.equal(run({ ...opening, contactOpen: true }, contactWindow, {
        lastAutoAction: now - 5 * 60000,
    }).blockedReason, 'MIN_MOVEMENT_INTERVAL');
});

function interpolatedWeather(includePast = true, overrides = {}) {
    const cfg = { ...c(), ...overrides };
    const states = new Map();
    const hours = includePast ? [-1, 2, 5, 8, 11, 14, 17, 20, 23, 26] : [2, 5, 8, 11, 14, 17, 20, 23, 26];
    forecastMappings(cfg).slice(0, hours.length).forEach((m, index) => {
        const h = hours[index];
        for (const [id, val] of [[m.timeState, now + h * 3600000], [m.temperatureState, 30 - h * 2], [m.cloudsState, h < 0 ? 0 : 90]])
            states.set(id, { val, ts: now });
    });
    return { cfg, states, result: prepareWeather(now, states, cfg) };
}

test('current weather and the three-hour temperature are interpolated at their actual times', () => {
    const { result } = interpolatedWeather();
    assert.equal(result.valid, true);
    assert.equal(result.outside, 30);
    assert.equal(result.clouds, 30);
    assert.equal(result.outsideSource, 'interpolated');
    assert.equal(result.cloudsSource, 'interpolated');
    assert.equal(forecastAt(result.interpolationPoints, now + 3 * 3600000).temperature, 24);
    assert(result.points.every((p) => p.time >= now), 'past points only support interpolation');
});

test('observed weather wins; missing bracketing data never turns future clouds into present clouds', () => {
    const { cfg, states } = interpolatedWeather(true, {
        currentOutsideTemperatureState: 'outside', currentCloudCoverState: 'clouds',
    });
    states.set('outside', { val: 33, ts: now });
    states.set('clouds', { val: 10, ts: now });
    const measured = prepareWeather(now, states, cfg);
    assert.equal(measured.outside, 33);
    assert.equal(measured.clouds, 10);
    assert.equal(measured.outsideSource, 'observed');
    assert.equal(measured.cloudsSource, 'observed');
    const unavailable = interpolatedWeather(false).result;
    assert.equal(unavailable.valid, true);
    assert(Number.isNaN(unavailable.outside));
    assert.equal(unavailable.clouds, 0);
    assert.equal(unavailable.outsideSource, 'unavailable');
    assert.equal(unavailable.cloudsSource, 'clear-sky-fallback');
    assert.equal(forecastAt([{ time: now - 4 * 3600000, temperature: 30, clouds: 0 },
        { time: now + 3600000, temperature: 20, clouds: 100 }], now), undefined);
});

test('evening cooling works between forecast samples and is disabled without current temperature', () => {
    const evening = atTime(now, '18:00');
    const samples = [-1, 2, 5].map((h) => ({ time: evening + h * 3600000, temperature: 30 - 2 * h, clouds: 0 }));
    const i = {
        now: evening, position: 25, roomTemperature: 24, sun: { azimuth: 270, elevation: 35 },
        weather: { ...weather(), outside: 30, points: samples.slice(1), interpolationPoints: samples },
    };
    const r = { managedDate: localDate(now) };
    const d = run(i, { windowAzimuth: 270 }, r, { openingStabilityMinutes: 0 });
    assert.equal(d.decisionReason, 'EVENING_RELAXATION');
    assert.equal(d.effectiveTargetPosition, 50);
    const unknown = run({ ...i, weather: { ...i.weather, outside: NaN } }, { windowAzimuth: 270 }, r);
    assert.equal(unknown.effectiveTargetPosition, 25);
});

test('ten-minute future sampling sees a solar exposure interval between weather timestamps', () => {
    const start = new Date(2026, 6, 1, 10).getTime();
    const middle = solarPosition(start + 1.5 * 3600000, 52.52, 13.405);
    const window = { ...w(), windowAzimuth: middle.azimuth, sunAzimuthMin: middle.azimuth - 10, sunAzimuthMax: middle.azimuth + 10 };
    for (const hour of [0, 3]) assert.equal(exposure(solarPosition(start + hour * 3600000, 52.52, 13.405), 0, window, c()), 0);
    const samples = futureSunSamples(start, 3, 52.52, 13.405, () => 0);
    assert.equal(samples.length, 18);
    assert(Math.max(...samples.map((p) => exposure(p.sun, p.clouds, window, c()))) > 30);
    const d = run({ now: start, sun: solarPosition(start, 52.52, 13.405), futureSuns: samples }, window);
    assert(d.effectiveTargetPosition < 100);
    assert.deepEqual(futureSunSamples(start, 0, 52.52, 13.405, () => 0), []);
    assert.equal(futureSunSamples(start, 0.25, 52.52, 13.405, () => 0).length, 2);
});

test('new thermal and solar configuration rejects impossible ranges', () => {
    for (const overrides of [
        { openingStabilityMinutes: -1 }, { thermalActivationRisk: 101 },
        { thermalActivationRisk: 5, thermalActivationHysteresis: 6 },
        { roomOverheatTemperature: 29, emergencyRoomTemperature: 28 },
        { roomOverheatMinimumRisk: 101 }, { lowSunFullStrengthElevation: 0 },
        { futureExposureHours: 25 },
    ]) assert.throws(() => parseConfig(overrides));
});

test('packaged native defaults agree with the defaults exercised by the decision engine', () => {
    assert.deepEqual(require('../io-package.json').native, defaults);
});
