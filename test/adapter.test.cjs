const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { defaults, windowDefaults } = require('../build/lib/config');
const { forecastMappings } = require('../build/lib/weather');
const { newRuntime, localDate } = require('../build/lib/engine');

class MockAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = 'blindcontrol.0';
        this.config = options.native;
        this.states = options.states ?? new Map();
        this.foreign = options.foreign;
        this.commands = [];
        this.objects = new Map();
        this.logs = [];
        this.log = Object.fromEntries(
            ['info', 'error', 'warn', 'debug'].map((level) => [level, (message) => this.logs.push({ level, message })]),
        );
    }
    async setObjectNotExistsAsync(id, object) {
        this.objects.set(id, object);
    }
    async getStateAsync(id) {
        return this.states.get(id) ?? null;
    }
    async setStateAsync(id, value, ack) {
        this.states.set(id, { val: value, ack, ts: Date.now() });
    }
    async setStateChangedAsync(...args) {
        await this.setStateAsync(...args);
    }
    async getForeignObjectAsync() {
        return { common: { latitude: 51, longitude: 7 } };
    }
    async getForeignStateAsync(id) {
        return this.foreign.get(id);
    }
    async subscribeStatesAsync() {}
    async subscribeForeignStatesAsync() {}
    async setForeignStateAsync(id, val, ack) {
        const runtime = JSON.parse(this.states.get('windows.south.runtime').val);
        assert(runtime.lastAutoAction > 0, 'cooldown must be durable before command');
        assert(runtime.commandId, 'command identity must be durable');
        this.commands.push({ id, val, ack });
    }
}
const originalLoad = Module._load;
Module._load = function (id, ...rest) {
    return id === '@iobroker/adapter-core' ? { Adapter: MockAdapter } : originalLoad.call(this, id, ...rest);
};
const create = require('../build/main');
Module._load = originalLoad;
async function fixture(t, overrides = {}, states, foreignOverrides = new Map()) {
    const now = Date.now();
    const window = {
        ...windowDefaults,
        id: 'south',
        name: 'South',
        blindSetState: 'blind.set',
        blindActualState: 'blind.actual',
        roomTemperatureState: 'room.temp',
    };
    const native = {
        ...structuredClone(defaults),
        enabled: true,
        dryRun: false,
        emergencyEnabled: false,
        startupDelaySeconds: 3600,
        controlStart: '00:00',
        controlEnd: '23:59',
        earliestAutoOpen: '00:00',
        sunSource: 'states',
        sunAzimuthState: 'sun.az',
        sunElevationState: 'sun.el',
        windows: [window],
        ...overrides,
    };
    const foreign = new Map([
        ['blind.actual', { val: 100, ts: now, ack: true }],
        ['room.temp', { val: 28, ts: now, ack: true }],
        ['sun.az', { val: 180, ts: now, ack: true }],
        ['sun.el', { val: 50, ts: now, ack: true }],
    ]);
    forecastMappings(native)
        .slice(0, 9)
        .forEach((m, index) => {
            for (const [id, val] of [
                [m.timeState, now + (index * 3 + 0.1) * 3600000],
                [m.temperatureState, 34],
                [m.cloudsState, 0],
            ])
                foreign.set(id, { val, ts: now, ack: true });
        });
    for (const [id, state] of foreignOverrides) foreign.set(id, state);
    const adapter = create({ native, states, foreign });
    t.after(async () => new Promise((resolve) => adapter.emit('unload', resolve)));
    await adapter.ready();
    assert.equal(adapter.logs.filter((l) => l.level === 'error').length, 0, JSON.stringify(adapter.logs));
    return adapter;
}
test('startup subscribes and creates controls without moving before delay', async (t) => {
    const a = await fixture(t);
    assert.equal(a.commands.length, 0);
    assert.equal(a.started, false);
    assert(a.objects.get('windows.south.enabled').common.write);
    assert.equal(a.objects.get('windows.south.runtime').common.write, false);
});
test('dry-run updates diagnostics without commands or simulated movement timestamps', async (t) => {
    const a = await fixture(t, { dryRun: true });
    await a.evaluate();
    assert.equal(a.commands.length, 0);
    assert.equal(a.states.get('windows.south.effectiveTargetPosition').val, 0);
    assert.equal(JSON.parse(a.states.get('windows.south.runtime').val).lastAutoAction, 0);
});
test('runtime switch persists and can re-enable a window initially disabled in admin', async (t) => {
    const win = {
        ...windowDefaults,
        enabled: false,
        id: 'south',
        blindSetState: 'blind.set',
        blindActualState: 'blind.actual',
        roomTemperatureState: 'room.temp',
    };
    const a = await fixture(t, { windows: [win] });
    await a.evaluate();
    assert.equal(a.commands.length, 0);
    await a.stateChanged('blindcontrol.0.windows.south.enabled', {
        val: true,
        ack: false,
        ts: Date.now(),
    });
    await a.evaluate();
    assert.equal(a.commands.length, 1);
    assert.equal(a.states.get('windows.south.enabled').ack, true);
});
test('command cooldown survives real adapter startup with reused persisted states', async (t) => {
    const a = await fixture(t);
    await a.evaluate();
    assert.equal(a.commands.length, 1);
    const b = await fixture(t, {}, a.states);
    await b.evaluate();
    assert.equal(b.commands.length, 0);
    assert(['MIN_MOVEMENT_INTERVAL', 'MANUAL_HOLD'].includes(b.states.get('windows.south.blockedReason').val));
});
test('own feedback is automatic; subsequent manual movement persists its hold across restart', async (t) => {
    const a = await fixture(t);
    await a.evaluate();
    await a.stateChanged('blind.actual', { val: 75, ack: true, ts: Date.now() });
    assert.equal(JSON.parse(a.states.get('windows.south.runtime').val).lastManualAction, 0);
    await a.stateChanged('blind.actual', { val: 0, ack: true, ts: Date.now() });
    await a.stateChanged('blind.actual', { val: 100, ack: true, ts: Date.now() });
    const r = JSON.parse(a.states.get('windows.south.runtime').val);
    assert(r.manualHoldUntil > Date.now() + 59 * 60000);
    const b = await fixture(t, {}, a.states);
    await b.evaluate();
    assert.equal(b.commands.length, 0);
    assert.equal(b.states.get('windows.south.blockedReason').val, 'MANUAL_HOLD');
});
test('pause date is persisted and previous local calendar day is cleared at startup', async (t) => {
    const states = new Map([
        ['control.pauseToday', { val: true, ack: true }],
        ['control.pauseDate', { val: '2020-01-01', ack: true }],
    ]);
    const a = await fixture(t, {}, states);
    assert.equal(a.states.get('control.pauseToday').val, false);
    await a.stateChanged('blindcontrol.0.control.pauseToday', {
        val: true,
        ack: false,
        ts: Date.now(),
    });
    assert.equal(a.states.get('control.pauseDate').val, localDate(Date.now()));
    await a.evaluate();
    assert.equal(a.commands.length, 0);
});
test('changes during async evaluation cancel a stale movement', async (t) => {
    const a = await fixture(t);
    const original = a.persist.bind(a);
    a.persist = async (id) => {
        await original(id);
        a.revision++;
    };
    await a.evaluate();
    assert.equal(a.commands.length, 0);
    assert.equal(a.states.get('windows.south.blockedReason').val, 'INPUT_CHANGED');
});
test('contact safety and global disable survive adapter integration', async (t) => {
    const win = {
        ...windowDefaults,
        id: 'south',
        blindSetState: 'blind.set',
        blindActualState: 'blind.actual',
        roomTemperatureState: 'room.temp',
        contactState: 'contact',
    };
    const a = await fixture(t, { windows: [win] });
    await a.stateChanged('contact', { val: true, ack: true, ts: Date.now() });
    await a.evaluate();
    assert.equal(a.commands.length, 0);
    assert.equal(a.states.get('windows.south.blockedReason').val, 'CONTACT_OPEN');
    await a.stateChanged('blindcontrol.0.control.enabled', {
        val: false,
        ack: false,
        ts: Date.now(),
    });
    await a.evaluate();
    assert.equal(a.commands.length, 0);
    assert.equal(a.states.get('windows.south.blockedReason').val, 'GLOBAL_DISABLED');
});
test('failed device write retains cooldown and reports failure', async (t) => {
    const a = await fixture(t);
    a.setForeignStateAsync = async () => {
        throw new Error('Connection lost');
    };
    await a.evaluate();
    assert.equal(a.states.get('windows.south.blockedReason').val, 'COMMAND_FAILED');
    assert(JSON.parse(a.states.get('windows.south.runtime').val).lastAutoAction > 0);
});

test('pause requested while offline uses its activation date on restart', async (t) => {
    const states = new Map([
        ['control.pauseToday', { val: true, ack: false, ts: Date.now() }],
        ['control.pauseDate', { val: '', ack: true }],
    ]);
    const a = await fixture(t, {}, states);
    await a.evaluate();
    assert.equal(a.commands.length, 0);
    assert.equal(a.states.get('control.pauseToday').val, true);
    assert.equal(a.states.get('control.pauseDate').val, localDate(Date.now()));
});

test('unknown contact payload and missing inputs cannot trigger commands', async (t) => {
    const win = {
        ...windowDefaults,
        id: 'south',
        blindSetState: 'blind.set',
        blindActualState: 'blind.actual',
        roomTemperatureState: 'room.temp',
        contactState: 'contact',
    };
    const a = await fixture(t, { windows: [win] });
    await a.stateChanged('contact', { val: 'unavailable', ack: true, ts: Date.now() });
    await a.evaluate();
    assert.equal(a.commands.length, 0);
    assert.equal(a.states.get('windows.south.blockedReason').val, 'INVALID_CONTACT');
    await a.stateChanged('room.temp', null);
    await a.evaluate();
    assert.equal(a.commands.length, 0);
    assert.equal(a.states.get('windows.south.blockedReason').val, 'INVALID_ROOM_TEMPERATURE');
});

test('slow manual movement is detected cumulatively before any automatic command', async (t) => {
    const a = await fixture(t, { dryRun: true });
    for (const val of [99, 98, 97, 96]) await a.stateChanged('blind.actual', { val, ack: true, ts: Date.now() });
    assert(JSON.parse(a.states.get('windows.south.runtime').val).manualHoldUntil > Date.now());
    await a.evaluate();
    assert.equal(a.states.get('windows.south.blockedReason').val, 'MANUAL_HOLD');
});

test('morning preference is acknowledged, used by decisions and restored after restart', async (t) => {
    const clock = new Date();
    clock.setHours(9, 0, 0, 0);
    const originalNow = Date.now;
    Date.now = () => clock.getTime();
    t.after(() => {
        Date.now = originalNow;
    });
    const a = await fixture(t, { dryRun: true, futureExposureHours: 0 });
    assert.equal(a.objects.get('windows.south.autoOpenMorning').common.write, true);
    assert.equal(a.states.get('windows.south.autoOpenMorning').val, false);
    a.inputs.set('blind.actual', { val: 0, ts: Date.now(), ack: true });
    a.inputs.set('sun.az', { val: 0, ts: Date.now(), ack: true });
    await a.evaluate();
    assert.equal(a.states.get('windows.south.blockedReason').val, 'MORNING_OPEN_DISABLED');
    await a.stateChanged('blindcontrol.0.windows.south.autoOpenMorning', { val: true, ack: false, ts: Date.now() });
    assert.equal(a.states.get('windows.south.autoOpenMorning').ack, true);
    await a.evaluate();
    assert.equal(a.states.get('windows.south.decisionReason').val, 'MORNING_OPEN');
    assert.equal(a.states.get('windows.south.effectiveTargetPosition').val, 100);
    assert.equal(a.states.get('windows.south.enabled').val, true);
    const b = await fixture(t, { dryRun: true, futureExposureHours: 0 }, a.states);
    assert.equal(b.states.get('windows.south.autoOpenMorning').val, true);
    b.inputs.set('blind.actual', { val: 0, ts: Date.now(), ack: true });
    b.inputs.set('sun.az', { val: 0, ts: Date.now(), ack: true });
    await b.evaluate();
    assert.equal(b.states.get('windows.south.decisionReason').val, 'MORNING_OPEN');
    await b.stateChanged('blindcontrol.0.windows.south.autoOpenMorning', { val: false, ack: false, ts: Date.now() });
    await b.evaluate();
    assert.equal(b.states.get('windows.south.blockedReason').val, 'MORNING_OPEN_DISABLED');
    await b.stateChanged('blindcontrol.0.control.vacationMode', { val: true, ack: false, ts: Date.now() });
    await b.evaluate();
    assert.equal(b.states.get('windows.south.decisionReason').val, 'VACATION_MORNING_OPEN');
});

function fixedClock(t, hour = 12) {
    const today = new Date();
    today.setHours(hour, 0, 0, 0);
    let time = today.getTime();
    const original = Date.now;
    Date.now = () => time;
    t.after(() => { Date.now = original; });
    return (minutes) => { time += minutes * 60000; };
}

test('opening stability survives evaluations but requires fresh evidence after restart', async (t) => {
    const advance = fixedClock(t);
    const a = await fixture(t, { futureExposureHours: 0 });
    a.inputs.set('blind.actual', { val: 50, ts: Date.now(), ack: true });
    a.inputs.set('sun.az', { val: 0, ts: Date.now(), ack: true });
    const runtime = a.runtime.get('south');
    runtime.observedPosition = 50;
    runtime.managedDate = localDate(Date.now());
    for (let minute = 0; minute <= 15; minute += 5) {
        await a.evaluate();
        assert.equal(a.commands.length, 0);
        assert.equal(a.states.get('windows.south.blockedReason').val, 'OPENING_NOT_STABLE');
        if (minute < 15) advance(5);
    }
    const persisted = JSON.parse(a.states.get('windows.south.runtime').val);
    assert.equal(persisted.openingSince, Date.now() - 15 * 60000);
    const b = await fixture(t, { futureExposureHours: 0 }, a.states, new Map([
        ['blind.actual', { val: 50, ts: Date.now(), ack: true }],
    ]));
    assert.equal(b.runtime.get('south').openingSince, 0);
    b.inputs.set('blind.actual', { val: 50, ts: Date.now(), ack: true });
    for (let minute = 0; minute <= 20; minute += 5) {
        b.inputs.set('sun.az', { val: 0, ts: Date.now(), ack: true });
        b.inputs.set('sun.el', { val: 50, ts: Date.now(), ack: true });
        await b.evaluate();
        assert.equal(b.commands.length, minute === 20 ? 1 : 0);
        if (minute < 20) advance(5);
    }
    assert.equal(b.commands[0].val, 100);
});

test('keepClosed is acknowledged, persists across restart and blocks an enabled morning', async (t) => {
    fixedClock(t, 9);
    const a = await fixture(t, { futureExposureHours: 0 });
    await a.stateChanged('blindcontrol.0.windows.south.keepClosed', { val: true, ts: Date.now(), ack: false });
    await a.stateChanged('blindcontrol.0.windows.south.autoOpenMorning', { val: true, ts: Date.now(), ack: false });
    assert.equal(a.states.get('windows.south.keepClosed').ack, true);
    const b = await fixture(t, { futureExposureHours: 0 }, a.states);
    assert.equal(b.states.get('windows.south.keepClosed').val, true);
    b.inputs.set('blind.actual', { val: 0, ts: Date.now(), ack: true });
    b.inputs.set('sun.az', { val: 0, ts: Date.now(), ack: true });
    await b.evaluate();
    assert.equal(b.commands.length, 0);
    assert.equal(b.states.get('windows.south.blockedReason').val, 'KEEP_CLOSED');
    await b.stateChanged('blindcontrol.0.windows.south.keepClosed', { val: false, ts: Date.now(), ack: false });
    await b.evaluate();
    assert.equal(b.commands.length, 1);
    assert.equal(b.commands[0].val, 100);
});

test('automatic additional closing preserves manual privacy through feedback and restart', async (t) => {
    const advance = fixedClock(t);
    const a = await fixture(t, { futureExposureHours: 0, sunPositionMaxAge: 180 });
    await a.stateChanged('blind.actual', { val: 50, ts: Date.now(), ack: true });
    const manualTime = a.runtime.get('south').lastManualAction;
    advance(61);
    await a.evaluate();
    assert.equal(a.commands.length, 1);
    assert.equal(a.commands[0].val, 0);
    await a.stateChanged('blind.actual', { val: 0, ts: Date.now(), ack: true });
    assert.equal(a.runtime.get('south').manualPosition, 50);
    assert.equal(a.runtime.get('south').manualDirection, -1);
    const b = await fixture(t, { futureExposureHours: 0, forecastWeight: 0 }, a.states, new Map([
        ['blind.actual', { val: 0, ts: Date.now(), ack: true }],
        ['room.temp', { val: 19, ts: Date.now(), ack: true }],
    ]));
    assert.equal(b.runtime.get('south').lastManualAction, manualTime);
    assert.equal(b.runtime.get('south').manualDirection, -1);
    await b.evaluate();
    assert.equal(b.commands.length, 0);
    assert.equal(b.states.get('windows.south.blockedReason').val, 'MANUAL_CLOSED');
});

test('a completed morning with no movement releases old manual intent and allows later heat relaxation', async (t) => {
    fixedClock(t, 9);
    const a = await fixture(t, { futureExposureHours: 0 });
    await a.stateChanged('blindcontrol.0.windows.south.autoOpenMorning', { val: true, ts: Date.now(), ack: false });
    const r = a.runtime.get('south');
    Object.assign(r, {
        observedPosition: 0, manualPosition: 0, manualDirection: -1,
        lastManualAction: Date.now() - 12 * 3600000, manualHoldUntil: Date.now() - 11 * 3600000,
    });
    a.inputs.set('blind.actual', { val: 0, ts: Date.now(), ack: true });
    await a.evaluate();
    assert.equal(a.commands.length, 0);
    assert.equal(r.manualPosition, null);
    assert.equal(r.morningDate, localDate(Date.now()));
    assert.equal(r.managedDate, localDate(Date.now()));
    a.inputs.set('sun.az', { val: 0, ts: Date.now(), ack: true });
    await a.evaluate();
    assert.equal(a.states.get('windows.south.blockedReason').val, 'OPENING_NOT_STABLE');
});

test('old persisted runtimes migrate and weather-source uncertainty is visible in diagnostics', async (t) => {
    fixedClock(t);
    const r = newRuntime();
    for (const key of ['thermalActive', 'roomOverheated', 'openingSince', 'openingTarget', 'openingLastEvaluation']) delete r[key];
    const a = await fixture(t, { dryRun: true }, new Map([
        ['windows.south.runtime', { val: JSON.stringify(r), ack: true, ts: Date.now() }],
    ]));
    await a.evaluate();
    assert.equal(a.states.get('info.currentOutsideTemperatureSource').val, 'unavailable');
    assert.equal(a.states.get('info.currentOutsideTemperature').val, null);
    assert.equal(a.states.get('info.currentCloudCoverSource').val, 'clear-sky-fallback');
    assert.equal(a.states.get('info.currentCloudCover').val, 0);
    assert.equal(a.states.get('windows.south.thermalActive').val, true);
    assert.equal(a.states.get('windows.south.roomOverheated').val, true);
    assert.equal(a.commands.length, 0);
});
