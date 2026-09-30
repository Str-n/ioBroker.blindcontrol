import type { Config, WindowConfig } from './config';
import { angleDistance, clamp, exposure, type SunPosition } from './solar';
import { forecastAt, interpolate, type Weather } from './weather';
export interface Runtime {
    lastAutoAction: number;
    lastManualAction: number;
    manualHoldUntil: number;
    observedPosition: number | null;
    manualPosition: number | null;
    manualDirection: number;
    targetPosition: number | null;
    commandTimestamp: number;
    commandId: string;
    commandStartPosition: number;
    commandCompleted: boolean;
    heatBand: number;
    shadeLevel: number;
    morningDate: string;
    vacationCloseDate: string;
    managedDate: string;
    thermalActive: boolean;
    roomOverheated: boolean;
    openingSince: number;
    openingTarget: number | null;
    openingLastEvaluation: number;
}
export const newRuntime = (): Runtime => ({
    lastAutoAction: 0,
    lastManualAction: 0,
    manualHoldUntil: 0,
    observedPosition: null,
    manualPosition: null,
    manualDirection: 0,
    targetPosition: null,
    commandTimestamp: 0,
    commandId: '',
    commandStartPosition: 0,
    commandCompleted: false,
    heatBand: -1,
    shadeLevel: -1,
    morningDate: '',
    vacationCloseDate: '',
    managedDate: '',
    thermalActive: false,
    roomOverheated: false,
    openingSince: 0,
    openingTarget: null,
    openingLastEvaluation: 0,
});
export interface Input {
    now: number;
    enabled: boolean;
    pauseToday: boolean;
    vacationMode: boolean;
    dryRun: boolean;
    windowEnabled: boolean;
    keepClosed?: boolean;
    position?: number;
    roomTemperature?: number;
    contactOpen?: boolean;
    contactValid: boolean;
    sun?: SunPosition;
    weather: Weather;
    futureSuns: { sun: SunPosition; clouds: number }[];
    vacationCloseTime: number;
}
export interface Decision {
    desiredPosition: number | null;
    effectiveTargetPosition: number | null;
    solarExposure: number;
    decisionSolarExposure: number;
    heatRisk: number;
    blocked: boolean;
    blockedReason: string;
    decisionReason: string;
    move: boolean;
    manualHoldActive: boolean;
    nextAutoMovementAllowed: number;
    heatBand: number;
    shadeLevel: number;
    thermalActive: boolean;
    roomOverheated: boolean;
    openingSince: number;
    openingTarget: number | null;
    openingLastEvaluation: number;
    event?: 'morning' | 'close';
}
export function localDate(now: number): string {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function atTime(now: number, hhmm: string): number {
    const d = new Date(now),
        [hour, minute] = hhmm.split(':').map(Number);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
}
export function inControlTime(now: number, c: Config): boolean {
    const start = atTime(now, c.controlStart),
        end = atTime(now, c.controlEnd);
    return start <= end ? now >= start && now <= end : now >= start || now <= end;
}
export function pauseExpired(paused: boolean, date: string, now: number): boolean {
    return paused && date !== localDate(now);
}
export function hysteresis(value: number, boundaries: number[], previous: number, margin: number): number {
    if (previous < 0 || previous > boundaries.length) return boundaries.filter((b) => value >= b).length;
    let band = previous;
    while (band < boundaries.length && value >= boundaries[band] + margin) band++;
    while (band > 0 && value < boundaries[band - 1] - margin) band--;
    return band;
}
export function decide(i: Input, w: WindowConfig, c: Config, r: Runtime): Decision {
    const d: Decision = {
        desiredPosition: null,
        effectiveTargetPosition: null,
        solarExposure: 0,
        decisionSolarExposure: 0,
        heatRisk: 0,
        blocked: false,
        blockedReason: 'NONE',
        decisionReason: 'NONE',
        move: false,
        manualHoldActive: false,
        nextAutoMovementAllowed: r.lastAutoAction ? r.lastAutoAction + c.minAutoMovementIntervalMinutes * 60000 : 0,
        heatBand: r.heatBand,
        shadeLevel: r.shadeLevel,
        thermalActive: r.thermalActive,
        roomOverheated: r.roomOverheated,
        openingSince: 0,
        openingTarget: null,
        openingLastEvaluation: 0,
    };
    const block = (reason: string): Decision => {
        d.blocked = true;
        d.blockedReason = reason;
        return d;
    };
    // Compute diagnostics even while globally paused, then apply guards in priority order.
    const validRoom = Number.isFinite(i.roomTemperature) && i.roomTemperature! >= -40 && i.roomTemperature! <= 80;
    const validSun =
        i.sun &&
        Number.isFinite(i.sun.azimuth) &&
        Number.isFinite(i.sun.elevation) &&
        i.sun.azimuth >= 0 &&
        i.sun.azimuth <= 360 &&
        i.sun.elevation >= -90 &&
        i.sun.elevation <= 90;
    if (validRoom && i.weather.valid) {
        const room = i.roomTemperature! + w.temperatureOffset;
        d.roomOverheated =
            room >= c.roomOverheatTemperature ||
            (r.roomOverheated && room >= c.roomOverheatTemperature - c.roomOverheatHysteresis);
        const roomRiskFloor = Math.max(
            d.roomOverheated ? c.roomOverheatMinimumRisk : 0,
            room >= c.emergencyRoomTemperature ? c.emergencyHeatRisk : 0,
        );
        d.heatRisk = clamp(
            (i.weather.risk * c.forecastWeight +
                interpolate(i.roomTemperature! + w.temperatureOffset, c.roomTemperatureCurve) *
                    c.roomTemperatureWeight) /
                (c.forecastWeight + c.roomTemperatureWeight) +
                w.heatProtectionOffset,
        );
        d.heatRisk = Math.max(d.heatRisk, roomRiskFloor);
        d.heatBand = hysteresis(d.heatRisk, c.heatRiskThresholds, r.heatBand, c.heatRiskHysteresis);
        // Measured overheating takes effect immediately, including at a band boundary.
        d.heatBand = Math.max(d.heatBand, c.heatRiskThresholds.filter((b) => roomRiskFloor >= b).length);
        d.thermalActive =
            d.roomOverheated ||
            room >= c.emergencyRoomTemperature ||
            d.heatRisk >= c.thermalActivationRisk ||
            (r.thermalActive && d.heatRisk >= c.thermalActivationRisk - c.thermalActivationHysteresis);
    }
    if (validSun && i.weather.valid) {
        d.solarExposure = exposure(i.sun!, i.weather.clouds, w, c);
        const future = Math.max(0, ...i.futureSuns.map((p) => exposure(p.sun, p.clouds, w, c)));
        d.decisionSolarExposure = Math.max(d.solarExposure, d.heatBand >= 2 ? future * c.futureExposureWeight : 0);
        d.shadeLevel = hysteresis(
            d.decisionSolarExposure,
            c.shadeLevels.slice(1).map((s) => s.minExposure),
            r.shadeLevel,
            c.solarExposureHysteresis,
        );
    }
    d.manualHoldActive = !!r.lastManualAction && i.now < r.manualHoldUntil;
    if (!i.enabled) return block('GLOBAL_DISABLED');
    if (i.pauseToday) return block('PAUSED_TODAY');
    if (!i.weather.valid) return block('INVALID_FORECAST');
    if (!validRoom) return block('INVALID_ROOM_TEMPERATURE');
    if (!validSun) return block('INVALID_SUN_POSITION');
    if (!Number.isFinite(i.position) || i.position! < 0 || i.position! > 100) return block('INVALID_BLIND_POSITION');
    if (!i.windowEnabled) return block('WINDOW_DISABLED');
    if (w.contactState && w.contactMode !== 'ignore' && !i.contactValid) return block('INVALID_CONTACT');
    const position = i.position!,
        date = localDate(i.now);
    let target = d.thermalActive
        ? Math.max(c.shadeLevels[d.shadeLevel].position, c.daylightMinimumPositions[d.heatBand])
        : 100;
    d.decisionReason =
        d.heatBand >= 3 ? 'EXTREME_HEAT_PROTECTION' : d.heatBand >= 2 ? 'HIGH_HEAT_PROTECTION' : 'SUN_PROTECTION';
    if (!d.thermalActive) d.decisionReason = 'NO_THERMAL_DEMAND';
    if (
        d.thermalActive &&
        d.heatBand === 3 &&
        angleDistance(w.windowAzimuth, 180) <= c.southTolerance &&
        d.decisionSolarExposure >= c.extremeHeatExposure
    )
        target = 0;
    const emergency =
        c.emergencyEnabled &&
        i.roomTemperature! + w.temperatureOffset >= c.emergencyRoomTemperature &&
        d.heatRisk >= c.emergencyHeatRisk;
    const nextForecast = forecastAt(i.weather.interpolationPoints ?? i.weather.points, i.now + 3 * 3600000);
    const evening =
        i.now >= atTime(i.now, c.eveningStart) &&
        d.solarExposure > 0 &&
        !!nextForecast &&
        i.weather.outside - nextForecast.temperature >= c.eveningCoolingDelta &&
        i.roomTemperature! + w.temperatureOffset < c.eveningCriticalRoomTemperature &&
        !emergency &&
        r.manualPosition === null;
    if (evening) {
        const positions = [...c.shadeLevels]
            .map((p) => p.position)
            .sort((a, b) => a - b);
        // Relax the thermal target once, rather than ratcheting up from each actual position.
        const relaxedTarget = positions.find((p) => p > target) ?? target;
        if (relaxedTarget > position) {
            target = Math.min(relaxedTarget, positions.find((p) => p > position) ?? relaxedTarget);
            if (d.thermalActive) d.decisionReason = 'EVENING_RELAXATION';
        } else {
            target = relaxedTarget;
        }
    }
    const closingEvent = i.vacationMode && i.now >= i.vacationCloseTime;
    const morningEvent =
        !closingEvent &&
        (w.autoOpenMorning || i.vacationMode) &&
        r.morningDate !== date &&
        i.now >= atTime(i.now, c.earliestAutoOpen) &&
        i.now < atTime(i.now, c.eveningStart);
    if (closingEvent) {
        target = 0;
        d.event = 'close';
        d.decisionReason = 'VACATION_EVENING_CLOSE';
    } else if (morningEvent) {
        target = Math.min(w.morningOpenPosition, target);
        d.event = 'morning';
        d.decisionReason = i.vacationMode ? 'VACATION_MORNING_OPEN' : 'MORNING_OPEN';
    }
    const safetyOpen = !!i.contactOpen && w.contactMode === 'forceOpenWhileOpen';
    if (safetyOpen) {
        target = Math.max(position, w.safetyPosition);
        d.event = undefined;
        d.decisionReason = 'CONTACT_SAFETY_OPEN';
    }
    d.desiredPosition = clamp(target);
    d.effectiveTargetPosition = d.desiredPosition;
    if (i.contactOpen && w.contactMode !== 'ignore' && target < position) return block('CONTACT_OPEN');
    // Only an event scheduled AFTER the manual action releases an extended hold.
    const scheduledRelease =
        (morningEvent && atTime(i.now, c.earliestAutoOpen) > r.lastManualAction) ||
        (closingEvent && i.vacationCloseTime > r.lastManualAction);
    d.manualHoldActive ||=
        r.manualPosition !== null &&
        !scheduledRelease &&
        !safetyOpen &&
        d.solarExposure < c.manualHoldLowExposureThreshold;
    if (d.manualHoldActive) return block('MANUAL_HOLD');
    if (target > position && !safetyOpen) {
        if (i.keepClosed) return block('KEEP_CLOSED');
        if (r.manualPosition !== null && r.manualDirection < 0 && !scheduledRelease) {
            d.manualHoldActive = true;
            return block('MANUAL_CLOSED');
        }
    }
    if (r.manualPosition !== null && r.manualDirection > 0 && target >= position && !scheduledRelease && !safetyOpen)
        return block('NO_RELEVANT_SOLAR_EXPOSURE');
    const emergencyClosing = emergency && target < position && !closingEvent && !safetyOpen;
    if (emergencyClosing) {
        d.nextAutoMovementAllowed = r.lastAutoAction ? r.lastAutoAction + c.emergencyMinMovementInterval * 60000 : 0;
        d.decisionReason = 'EMERGENCY_HEAT_PROTECTION';
    }
    if (!inControlTime(i.now, c) && !(i.vacationMode && (morningEvent || closingEvent)) && !safetyOpen)
        return block('OUTSIDE_CONTROL_TIME');
    if (target > position && i.now < atTime(i.now, c.earliestAutoOpen)) return block('EARLIEST_OPEN_NOT_REACHED');
    // A closed bedroom must not be opened by ordinary heat control each morning.
    if (target > position && !morningEvent && !safetyOpen && r.managedDate !== date && !i.vacationMode)
        return block('MORNING_OPEN_DISABLED');
    if (Math.abs(target - position) < c.minPositionChange) return block('POSITION_CHANGE_TOO_SMALL');
    const ordinaryOpening = target > position && !morningEvent && !safetyOpen;
    if (ordinaryOpening) {
        const continuous =
            r.openingTarget === target &&
            r.openingSince > 0 &&
            i.now >= r.openingLastEvaluation &&
            i.now - r.openingLastEvaluation <= Math.max(1, 2 * c.evaluationIntervalMinutes) * 60000;
        d.openingSince = continuous ? r.openingSince : i.now;
        d.openingTarget = target;
        d.openingLastEvaluation = i.now;
    }
    if (i.now < d.nextAutoMovementAllowed) return block('MIN_MOVEMENT_INTERVAL');
    if (ordinaryOpening && i.now - d.openingSince < c.openingStabilityMinutes * 60000)
        return block('OPENING_NOT_STABLE');
    d.move = !i.dryRun;
    return d;
}
export function observePosition(
    r: Runtime,
    previous: number | undefined,
    value: number,
    now: number,
    c: Config,
    isCommand = false,
): 'unchanged' | 'automatic' | 'manual' {
    const tolerance = c.manualDetectionTolerance;
    // Commands to a distinct setpoint are handled even if actual position has not moved yet.
    if (!isCommand && previous !== undefined && Math.abs(value - previous) <= tolerance) return 'unchanged';
    const pending =
        !!r.commandId &&
        now >= r.commandTimestamp &&
        now - r.commandTimestamp <= c.selfActionRecognitionTimeout * 1000 &&
        r.targetPosition !== null;
    if (pending) {
        const target = r.targetPosition!;
        const atTarget = Math.abs(value - target) <= tolerance;
        const from = previous ?? r.commandStartPosition;
        const direction = Math.sign(target - r.commandStartPosition);
        const inPath =
            !r.commandCompleted &&
            !isCommand &&
            value >= Math.min(r.commandStartPosition, target) - tolerance &&
            value <= Math.max(r.commandStartPosition, target) + tolerance &&
            (value - from) * direction >= -tolerance;
        if (atTarget || inPath) {
            if (!isCommand) r.observedPosition = value;
            if (atTarget && !isCommand) r.commandCompleted = true;
            return 'automatic';
        }
    }
    if (previous === undefined && !isCommand) {
        r.observedPosition = value;
        return 'unchanged';
    }
    r.lastManualAction = now;
    r.manualHoldUntil = now + c.manualHoldMinutes * 60000;
    r.observedPosition = value;
    r.manualPosition = value;
    r.manualDirection = Math.sign(value - (previous ?? value));
    r.commandId = '';
    r.commandCompleted = false;
    r.openingSince = 0;
    r.openingTarget = null;
    r.openingLastEvaluation = 0;
    return 'manual';
}
