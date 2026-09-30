import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { randomUUID } from 'node:crypto';
import { parseConfig, type Config, type WindowConfig } from './lib/config';
import { atTime, decide, localDate, newRuntime, observePosition, pauseExpired, type Runtime } from './lib/engine';
import { solarPosition, sunset, type SunPosition } from './lib/solar';
import { forecastMappings, numeric, prepareWeather, timestamp, type Sample } from './lib/weather';

export class BlindControl extends Adapter {
    private settings!: Config;
    private readonly inputs = new Map<string, Sample>();
    private readonly runtime = new Map<string, Runtime>();
    private readonly switches = new Map<string, boolean>();
    private controls = {
        enabled: false,
        pauseToday: false,
        vacationMode: false,
        dryRun: true,
    };
    private pauseDate = '';
    private geoLatitude = NaN;
    private geoLongitude = NaN;
    private started = false;
    private stopped = false;
    private timer?: ReturnType<typeof setTimeout>;
    private interval?: ReturnType<typeof setInterval>;
    private midnight?: ReturnType<typeof setTimeout>;
    private startup?: ReturnType<typeof setTimeout>;
    private queue: Promise<void> = Promise.resolve();
    private lastReasons = new Map<string, string>();
    // A change arriving while evaluation awaits database writes cancels its stale command.
    private revision = 0;

    constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'blindcontrol' });
        this.on('ready', () => this.enqueue(() => this.ready()));
        this.on('stateChange', (id, state) => {
            if (id.startsWith(`${this.namespace}.`) && state?.ack) return;
            this.revision++;
            this.enqueue(() => this.stateChanged(id, state));
        });
        this.on('unload', (callback) => {
            this.stopped = true;
            if (this.timer) clearTimeout(this.timer);
            if (this.interval) clearInterval(this.interval);
            if (this.midnight) clearTimeout(this.midnight);
            if (this.startup) clearTimeout(this.startup);
            void this.setStateAsync('info.active', false, true).finally(callback);
        });
    }
    private enqueue(task: () => Promise<void>): void {
        this.queue = this.queue
            .then(async () => {
                if (!this.stopped) await task();
            })
            .catch((error) => {
                this.log.error(String(error));
            });
    }
    private async object(id: string, value: ioBroker.StateValue, write = false, role?: string): Promise<void> {
        const type = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string';
        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name: id.split('.').at(-1)!,
                type,
                role:
                    role ??
                    (type === 'boolean'
                        ? write
                            ? 'switch.enable'
                            : 'indicator'
                        : type === 'number'
                          ? 'value'
                          : 'text'),
                read: true,
                write,
                def: value,
            },
            native: {},
        });
        if (!(await this.getStateAsync(id))) await this.setStateAsync(id, value, true);
    }
    private async channel(id: string, name: string): Promise<void> {
        await this.setObjectNotExistsAsync(id, {
            type: 'channel',
            common: { name },
            native: {},
        });
    }
    private async ready(): Promise<void> {
        try {
            this.settings = parseConfig(this.config as unknown as Record<string, unknown>);
        } catch (error) {
            this.log.error(`Invalid configuration; no movements: ${error}`);
            return;
        }
        const c = this.settings;
        const system = await this.getForeignObjectAsync('system.config');
        const coordinate = (value: unknown): number =>
            value === '' || value === null || value === undefined ? NaN : Number(value);
        this.geoLatitude = coordinate(c.latitude === '' ? system?.common.latitude : c.latitude);
        this.geoLongitude = coordinate(c.longitude === '' ? system?.common.longitude : c.longitude);
        if (Math.abs(this.geoLatitude) > 90 || Math.abs(this.geoLongitude) > 180) {
            this.geoLatitude = NaN;
            this.geoLongitude = NaN;
        }
        await this.channel('control', 'Control');
        await this.channel('info', 'Diagnostics');
        await this.channel('windows', 'Windows');
        const pendingPause = await this.getStateAsync('control.pauseToday');
        for (const [key, value] of Object.entries({
            enabled: c.enabled,
            pauseToday: false,
            vacationMode: false,
            dryRun: c.dryRun,
        })) {
            await this.object(`control.${key}`, value, true);
            this.controls[key as keyof typeof this.controls] =
                (await this.getStateAsync(`control.${key}`))?.val === true;
            await this.setStateAsync(`control.${key}`, this.controls[key as keyof typeof this.controls], true);
        }
        await this.object('control.pauseDate', '');
        this.pauseDate = String((await this.getStateAsync('control.pauseDate'))?.val || '');
        if (pendingPause?.val === true && !pendingPause.ack && Number.isFinite(pendingPause.ts)) {
            this.pauseDate = localDate(pendingPause.ts);
            await this.setStateAsync('control.pauseDate', this.pauseDate, true);
        }
        await this.resetPause();
        const info = {
            active: false,
            lastEvaluation: 0,
            forecastValid: false,
            forecastHeatRisk: 0,
            forecastMaxTemperature24h: 0,
            forecastMinTemperature24h: 0,
            forecastHeatLoad24h: 0,
            currentOutsideTemperature: 0,
            currentCloudCover: 0,
            nextVacationOpen: 0,
            nextVacationClose: 0,
        };
        for (const [key, value] of Object.entries(info)) await this.object(`info.${key}`, value);
        for (const w of c.windows) {
            const prefix = `windows.${w.id}`;
            await this.channel(prefix, w.name || w.id);
            await this.object(`${prefix}.enabled`, w.enabled, true);
            this.switches.set(w.id, (await this.getStateAsync(`${prefix}.enabled`))?.val === true);
            await this.setStateAsync(`${prefix}.enabled`, this.switches.get(w.id)!, true);
            await this.object(`${prefix}.autoOpenMorning`, w.autoOpenMorning, true);
            w.autoOpenMorning = (await this.getStateAsync(`${prefix}.autoOpenMorning`))?.val === true;
            await this.setStateAsync(`${prefix}.autoOpenMorning`, w.autoOpenMorning, true);
            await this.object(`${prefix}.runtime`, JSON.stringify(newRuntime()));
            const raw = (await this.getStateAsync(`${prefix}.runtime`))?.val;
            try {
                const parsed = JSON.parse(String(raw));
                const r = { ...newRuntime(), ...parsed } as Runtime;
                // Corrupt persistence must never silently remove a manual or movement lock.
                for (const [key, value] of Object.entries(newRuntime())) {
                    const stored = r[key as keyof Runtime];
                    if (
                        value !== null &&
                        (typeof stored !== typeof value || (typeof value === 'number' && !Number.isFinite(stored)))
                    )
                        throw new Error(`Invalid runtime ${key}`);
                }
                for (const key of ['manualPosition', 'targetPosition', 'observedPosition'] as const)
                    if (
                        r[key] !== null &&
                        (typeof r[key] !== 'number' || !Number.isFinite(r[key]) || r[key]! < 0 || r[key]! > 100)
                    )
                        throw new Error(`Invalid runtime ${key}`);
                this.runtime.set(w.id, r);
            } catch {
                this.log.error(
                    `Invalid persisted runtime for ${w.id}; window disabled until restart with repaired runtime`,
                );
                this.switches.set(w.id, false);
                await this.setStateAsync(`${prefix}.enabled`, false, true);
                continue;
            }
            const diagnostics = {
                currentPosition: 0,
                roomTemperature: 0,
                solarExposure: 0,
                decisionSolarExposure: 0,
                heatRisk: 0,
                desiredPosition: 0,
                effectiveTargetPosition: 0,
                manualHoldActive: false,
                manualHoldUntil: 0,
                lastManualAction: 0,
                lastAutoAction: 0,
                nextAutoMovementAllowed: 0,
                contactOpen: false,
                blocked: true,
                blockedReason: 'STARTUP',
                decisionReason: 'NONE',
                targetPosition: 0,
                commandTimestamp: 0,
                commandId: '',
            };
            for (const [key, value] of Object.entries(diagnostics)) await this.object(`${prefix}.${key}`, value);
        }
        await this.subscribeStatesAsync('control.*');
        await this.subscribeStatesAsync('windows.*.enabled');
        await this.subscribeStatesAsync('windows.*.autoOpenMorning');
        const ids = new Set<string>(
            [
                ...forecastMappings(c).flatMap((m) => [m.timeState, m.temperatureState, m.cloudsState]),
                c.currentOutsideTemperatureState,
                c.currentCloudCoverState,
                c.sunAzimuthState,
                c.sunElevationState,
                c.sunsetState,
                ...c.windows.flatMap((w) => [
                    w.blindActualState,
                    w.blindSetState,
                    w.roomTemperatureState,
                    w.contactState || '',
                ]),
            ].filter(Boolean),
        );
        for (const id of ids) {
            if (id.startsWith(`${this.namespace}.`))
                throw new Error('Input/output mappings must reference foreign states');
            await this.subscribeForeignStatesAsync(id);
            const state = await this.getForeignStateAsync(id);
            if (state) this.inputs.set(id, state);
        }
        // Detect an untracked position change while the adapter was offline, conservatively.
        for (const w of c.windows) {
            const r = this.runtime.get(w.id),
                sample = this.inputs.get(w.blindActualState);
            if (!r || !sample) continue;
            const value = numeric(sample, Date.now(), c.blindPositionMaxAge);
            const previous = r.manualPosition ?? r.targetPosition;
            if (value !== undefined && previous !== null && Math.abs(value - previous) > c.manualDetectionTolerance) {
                observePosition(r, previous, value, Date.now(), c);
            }
            if (value !== undefined) {
                r.observedPosition = value;
                await this.persist(w.id);
            }
        }
        this.armMidnight();
        this.startup = setTimeout(() => {
            this.started = true;
            this.requestEvaluation();
            this.interval = setInterval(() => this.requestEvaluation(), c.evaluationIntervalMinutes * 60000);
        }, c.startupDelaySeconds * 1000);
        this.log.info(`Loaded ${c.windows.length} windows; dry run ${this.controls.dryRun ? 'on' : 'off'}`);
    }
    private async resetPause(): Promise<void> {
        if (pauseExpired(this.controls.pauseToday, this.pauseDate, Date.now())) {
            this.controls.pauseToday = false;
            this.pauseDate = '';
            await this.setStateAsync('control.pauseToday', false, true);
            await this.setStateAsync('control.pauseDate', '', true);
        }
    }
    private armMidnight(): void {
        const next = new Date();
        next.setHours(24, 0, 0, 0);
        this.midnight = setTimeout(
            () =>
                this.enqueue(async () => {
                    await this.resetPause();
                    this.armMidnight();
                    this.requestEvaluation();
                }),
            Math.max(1, next.getTime() - Date.now()),
        );
    }
    private async persist(id: string): Promise<void> {
        await this.setStateAsync(`windows.${id}.runtime`, JSON.stringify(this.runtime.get(id)), true);
    }
    private async stateChanged(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!this.settings) return;
        if (id.startsWith(`${this.namespace}.`)) {
            if (!state || state.ack || typeof state.val !== 'boolean') return;
            const key = id.slice(this.namespace.length + 1);
            if (key.startsWith('control.')) {
                const control = key.slice(8) as keyof typeof this.controls;
                if (!(control in this.controls)) return;
                if (control === 'pauseToday') {
                    this.pauseDate = state.val ? localDate(Date.now()) : '';
                    await this.setStateAsync('control.pauseDate', this.pauseDate, true);
                }
                this.controls[control] = state.val;
                await this.setStateAsync(key, state.val, true);
            } else {
                const window = this.settings.windows.find(
                    (w) => key === `windows.${w.id}.enabled` || key === `windows.${w.id}.autoOpenMorning`,
                );
                if (!window) return;
                if (key.endsWith('.autoOpenMorning')) window.autoOpenMorning = state.val;
                else this.switches.set(window.id, state.val);
                await this.setStateAsync(key, state.val, true);
            }
        } else {
            const previous = this.inputs.get(id);
            if (state) this.inputs.set(id, state);
            else this.inputs.delete(id);
            for (const w of this.settings.windows) {
                const r = this.runtime.get(w.id);
                if (!r || !state || (id !== w.blindActualState && id !== w.blindSetState)) continue;
                const value = numeric(state, Date.now(), this.settings.blindPositionMaxAge);
                if (value === undefined) continue;
                const isCommand = !state.ack && id === w.blindSetState;
                if (id !== w.blindActualState && !isCommand) continue;
                const old = numeric(previous, Date.now(), this.settings.blindPositionMaxAge);
                // Retain a baseline across small position updates so slow manual travel is detected.
                const baseline = r.observedPosition ?? old;
                observePosition(
                    r,
                    isCommand
                        ? numeric(this.inputs.get(w.blindActualState), Date.now(), this.settings.blindPositionMaxAge)
                        : (baseline ?? undefined),
                    value,
                    Date.now(),
                    this.settings,
                    isCommand,
                );
                await this.persist(w.id);
            }
        }
        this.requestEvaluation();
    }
    private requestEvaluation(): void {
        if (!this.started || this.stopped || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.enqueue(() => this.evaluate());
        }, 250);
    }
    private closeTime(now: number): number {
        const c = this.settings;
        const external = this.inputs.get(c.sunsetState);
        const externalTime =
            external && !(external.q || 0) && now - external.ts <= 86400000 ? timestamp(external.val) : NaN;
        const calculated =
            Number.isFinite(this.geoLatitude) && Number.isFinite(this.geoLongitude)
                ? sunset(now, this.geoLatitude, this.geoLongitude)
                : NaN;
        const sun =
            Number.isFinite(externalTime) && localDate(externalTime) === localDate(now) ? externalTime : calculated;
        return Math.min(
            Number.isFinite(sun) ? sun + c.vacationSunsetOffsetMinutes * 60000 : Infinity,
            atTime(now, c.vacationLatestCloseTime),
        );
    }
    private async diagnostics(prefix: string, values: Record<string, ioBroker.StateValue | undefined>): Promise<void> {
        for (const [key, value] of Object.entries(values)) {
            await this.setStateChangedAsync(
                `${prefix}.${key}`,
                value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? null : value,
                true,
            );
        }
    }
    private async evaluate(): Promise<void> {
        await this.resetPause();
        const now = Date.now(),
            revision = this.revision,
            c = this.settings;
        const weather = prepareWeather(now, this.inputs, c);
        let sun: SunPosition | undefined;
        const haveCoordinates = Number.isFinite(this.geoLatitude) && Number.isFinite(this.geoLongitude);
        if (c.sunSource === 'coordinates' && haveCoordinates)
            sun = solarPosition(now, this.geoLatitude, this.geoLongitude);
        else if (c.sunSource === 'states') {
            const azimuth = numeric(this.inputs.get(c.sunAzimuthState), now, c.sunPositionMaxAge);
            const elevation = numeric(this.inputs.get(c.sunElevationState), now, c.sunPositionMaxAge);
            if (azimuth !== undefined && elevation !== undefined) sun = { azimuth, elevation };
        }
        const futureSuns = haveCoordinates
            ? weather.points
                  .filter((p) => p.time <= now + c.futureExposureHours * 3600000)
                  .map((p) => ({
                      sun: solarPosition(p.time, this.geoLatitude, this.geoLongitude),
                      clouds: p.clouds,
                  }))
            : [];
        const closeTime = this.closeTime(now);
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const nextOpen = atTime(now, c.earliestAutoOpen);
        await this.diagnostics('info', {
            active: this.controls.enabled && !this.controls.pauseToday,
            lastEvaluation: now,
            forecastValid: weather.valid,
            forecastHeatRisk: weather.valid ? weather.risk : null,
            forecastMaxTemperature24h: weather.max,
            forecastMinTemperature24h: weather.min,
            forecastHeatLoad24h: weather.heatLoad,
            currentOutsideTemperature: weather.outside,
            currentCloudCover: weather.clouds,
            nextVacationOpen: this.controls.vacationMode
                ? now < nextOpen
                    ? nextOpen
                    : atTime(tomorrow.getTime(), c.earliestAutoOpen)
                : 0,
            nextVacationClose: this.controls.vacationMode
                ? now < closeTime
                    ? closeTime
                    : this.closeTime(tomorrow.getTime())
                : 0,
        });
        for (const w of c.windows) {
            const r = this.runtime.get(w.id);
            if (!r) continue;
            const position = numeric(this.inputs.get(w.blindActualState), now, c.blindPositionMaxAge);
            const roomTemperature = numeric(this.inputs.get(w.roomTemperatureState), now, c.roomTemperatureMaxAge);
            const contact = this.inputs.get(w.contactState || '');
            const contactValid =
                !w.contactState ||
                (!!contact &&
                    contact.val !== null &&
                    contact.val !== undefined &&
                    [String(w.contactOpenValue), String(w.contactClosedValue)].includes(String(contact.val)) &&
                    (contact.q || 0) === 0 &&
                    Number.isFinite(contact.ts) &&
                    contact.ts <= now + 60000 &&
                    now - contact.ts <= c.contactMaxAge * 60000);
            const contactOpen = contactValid && !!contact && String(contact.val) === String(w.contactOpenValue);
            const d = decide(
                {
                    now,
                    ...this.controls,
                    windowEnabled: this.switches.get(w.id) === true,
                    position,
                    roomTemperature,
                    contactOpen,
                    contactValid,
                    sun,
                    weather,
                    futureSuns,
                    vacationCloseTime: closeTime,
                },
                w,
                c,
                r,
            );
            r.heatBand = d.heatBand;
            r.shadeLevel = d.shadeLevel;
            // Already at the daily target: remember the event without pretending a movement occurred.
            if (!this.controls.dryRun && d.event && d.blockedReason === 'POSITION_CHANGE_TOO_SMALL') {
                if (d.event === 'morning') r.morningDate = localDate(now);
                else r.vacationCloseDate = localDate(now);
            }
            await this.persist(w.id);
            if (d.move && !this.stopped && revision === this.revision) {
                const prior = { ...r };
                r.commandTimestamp = now;
                r.commandId = randomUUID();
                r.targetPosition = d.effectiveTargetPosition;
                r.commandStartPosition = position!;
                r.observedPosition = position!;
                r.commandCompleted = false;
                // Persist BEFORE issuing a command so a crash cannot erase its cooldown.
                r.lastAutoAction = now;
                r.manualPosition = null;
                r.manualHoldUntil = 0;
                r.managedDate = localDate(now);
                if (d.event === 'morning') r.morningDate = localDate(now);
                if (d.event === 'close') r.vacationCloseDate = localDate(now);
                await this.persist(w.id);
                if (this.stopped || revision !== this.revision) {
                    Object.assign(r, prior);
                    await this.persist(w.id);
                    d.blocked = true;
                    d.blockedReason = 'INPUT_CHANGED';
                    this.requestEvaluation();
                } else {
                    try {
                        await this.setForeignStateAsync(w.blindSetState, d.effectiveTargetPosition!, false);
                        this.log.info(`${w.id}: ${position}% -> ${d.effectiveTargetPosition}% (${d.decisionReason})`);
                    } catch (error) {
                        // Retain the cooldown: delivery may have succeeded before the error surfaced.
                        d.blocked = true;
                        d.blockedReason = 'COMMAND_FAILED';
                        this.log.error(`${w.id}: command failed: ${error}`);
                    }
                }
            } else if (d.move) {
                d.blocked = true;
                d.blockedReason = 'INPUT_CHANGED';
                this.requestEvaluation();
            }
            await this.diagnostics(`windows.${w.id}`, {
                currentPosition: position,
                roomTemperature,
                solarExposure: d.solarExposure,
                decisionSolarExposure: d.decisionSolarExposure,
                heatRisk: d.heatRisk,
                desiredPosition: d.desiredPosition,
                effectiveTargetPosition: d.effectiveTargetPosition,
                manualHoldActive: d.manualHoldActive,
                manualHoldUntil: r.manualHoldUntil,
                lastManualAction: r.lastManualAction,
                lastAutoAction: r.lastAutoAction,
                nextAutoMovementAllowed: r.lastAutoAction
                    ? r.lastAutoAction + c.minAutoMovementIntervalMinutes * 60000
                    : 0,
                contactOpen,
                blocked: d.blocked,
                blockedReason: d.blockedReason,
                decisionReason: d.decisionReason,
                targetPosition: r.targetPosition,
                commandTimestamp: r.commandTimestamp,
                commandId: r.commandId,
            });
            if (d.blockedReason.startsWith('INVALID_') && this.lastReasons.get(w.id) !== d.blockedReason)
                this.log.warn(`${w.id}: ${d.blockedReason}; no movement`);
            this.lastReasons.set(w.id, d.blockedReason);
        }
    }
}
if (require.main === module) new BlindControl();
else module.exports = (options: Partial<AdapterOptions>) => new BlindControl(options);
