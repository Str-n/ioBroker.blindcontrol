export interface CurvePoint {
    x: number;
    y: number;
}
export interface ShadeLevel {
    name: string;
    minExposure: number;
    position: number;
}
export interface ForecastMapping {
    timeState: string;
    temperatureState: string;
    cloudsState?: string;
}
export interface WindowConfig {
    id: string;
    name: string;
    enabled: boolean;
    blindSetState: string;
    blindActualState: string;
    roomTemperatureState: string;
    contactState?: string;
    contactMode: 'ignore' | 'blockClosing' | 'forceOpenWhileOpen';
    contactOpenValue: string;
    contactClosedValue: string;
    safetyPosition: number;
    windowAzimuth: number;
    sunAzimuthMin?: number;
    sunAzimuthMax?: number;
    sunElevationMin?: number;
    sunElevationMax?: number;
    autoOpenMorning: boolean;
    morningOpenPosition: number;
    temperatureOffset: number;
    heatProtectionOffset: number;
}
export const windowDefaults = {
    enabled: true,
    contactMode: 'blockClosing' as const,
    contactOpenValue: 'true',
    contactClosedValue: 'false',
    safetyPosition: 100,
    windowAzimuth: 180,
    autoOpenMorning: false,
    morningOpenPosition: 100,
    temperatureOffset: 0,
    heatProtectionOffset: 0,
};
export const defaults = {
    enabled: false,
    dryRun: true,
    controlStart: '06:00',
    controlEnd: '22:00',
    earliestAutoOpen: '07:00',
    evaluationIntervalMinutes: 5,
    minAutoMovementIntervalMinutes: 60,
    minPositionChange: 10,
    openingStabilityMinutes: 20,
    startupDelaySeconds: 30,
    weatherProvider: 'openweathermap',
    openWeatherMapInstance: 'openweathermap.0',
    currentOutsideTemperatureState: '',
    currentCloudCoverState: '',
    currentSunlightSource: 'clouds',
    currentRadiationState: '0_userdata.0.sunlight.overall.irradiance_estimated',
    radiationInputUnit: 'W/m²',
    radiationLuxPerWm2: 120,
    radiationValidState: '0_userdata.0.sunlight.overall.valid',
    radiationLastSuccessState: '0_userdata.0.sunlight.overall.last_success',
    radiationSourcesState: '0_userdata.0.sunlight.overall.sources_used',
    radiationStatusState: '0_userdata.0.sunlight.overall.status',
    radiationMaxAge: 25,
    radiationRefreshGraceSeconds: 30,
    radiationMinSunElevation: 5,
    forecastMapping: [] as ForecastMapping[],
    heatLoadBaseTemperature: 22,
    coolingTemperature: 16,
    coolingReductionPerHour: 2,
    maxTemperatureCurve: [
        { x: 20, y: 0 },
        { x: 23, y: 35 },
        { x: 26, y: 60 },
        { x: 28, y: 80 },
        { x: 29, y: 100 },
    ],
    heatLoadCurve: [
        { x: 0, y: 0 },
        { x: 24, y: 30 },
        { x: 48, y: 55 },
        { x: 72, y: 75 },
        { x: 96, y: 100 },
    ],
    warmNightCurve: [
        { x: 10, y: 0 },
        { x: 15, y: 20 },
        { x: 18, y: 50 },
        { x: 20, y: 75 },
        { x: 22, y: 100 },
    ],
    roomTemperatureCurve: [
        { x: 19, y: 0 },
        { x: 21, y: 20 },
        { x: 22, y: 40 },
        { x: 23, y: 60 },
        { x: 24, y: 75 },
        { x: 26, y: 100 },
    ],
    maxTemperatureWeight: 0.35,
    heatLoadWeight: 0.35,
    warmNightWeight: 0.3,
    forecastWeight: 0.7,
    roomTemperatureWeight: 0.3,
    sunSource: 'coordinates',
    latitude: '' as string | number,
    longitude: '' as string | number,
    sunAzimuthState: '',
    sunElevationState: '',
    sunsetState: '',
    cloudAttenuation: 0.8,
    lowSunFullStrengthElevation: 10,
    futureExposureHours: 3,
    futureExposureWeight: 0.8,
    shadeLevels: [
        { name: 'open', minExposure: 0, position: 100 },
        { name: 'light', minExposure: 25, position: 75 },
        { name: 'medium', minExposure: 45, position: 50 },
        { name: 'strong', minExposure: 65, position: 25 },
        { name: 'closed', minExposure: 85, position: 0 },
    ],
    heatRiskThresholds: [30, 55, 75],
    daylightMinimumPositions: [75, 50, 25, 0],
    southTolerance: 45,
    extremeHeatExposure: 60,
    eveningStart: '16:00',
    eveningCoolingDelta: 2,
    eveningCriticalRoomTemperature: 26,
    solarExposureHysteresis: 5,
    heatRiskHysteresis: 5,
    thermalActivationRisk: 20,
    thermalActivationHysteresis: 5,
    roomOverheatTemperature: 26,
    roomOverheatHysteresis: 0.5,
    roomOverheatMinimumRisk: 75,
    manualHoldMinutes: 60,
    manualHoldLowExposureThreshold: 20,
    manualDetectionTolerance: 3,
    selfActionRecognitionTimeout: 120,
    emergencyEnabled: true,
    emergencyRoomTemperature: 28,
    emergencyHeatRisk: 90,
    emergencyMinMovementInterval: 15,
    vacationSunsetOffsetMinutes: 0,
    vacationLatestCloseTime: '22:00',
    sunPositionMaxAge: 15,
    weatherCurrentMaxAge: 180,
    forecastMaxAge: 360,
    roomTemperatureMaxAge: 1440,
    blindPositionMaxAge: 10080,
    contactMaxAge: 10080,
    windows: [] as WindowConfig[],
};
export type Config = typeof defaults;

export function parseConfig(native: Record<string, unknown>): Config {
    const config = { ...defaults, ...native } as Config;
    // JSON Config's JSON editors persist text; table controls persist arrays.
    for (const key of Object.keys(defaults) as (keyof Config)[]) {
        if (Array.isArray(defaults[key]) && typeof config[key] === 'string') {
            (config as unknown as Record<string, unknown>)[key] = JSON.parse(config[key] as unknown as string);
        }
        if (
            typeof defaults[key] === 'number' &&
            (!Number.isFinite(config[key]) ||
                (Number(config[key]) < 0 &&
                    !['vacationSunsetOffsetMinutes', 'coolingTemperature', 'heatLoadBaseTemperature'].includes(key)))
        ) {
            throw new Error(`Invalid non-negative number: ${key}`);
        }
        if (typeof defaults[key] === 'boolean' && typeof config[key] !== 'boolean')
            throw new Error(`Invalid boolean: ${key}`);
    }
    for (const key of [
        'controlStart',
        'controlEnd',
        'earliestAutoOpen',
        'eveningStart',
        'vacationLatestCloseTime',
    ] as const) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config[key])) throw new Error(`Invalid time: ${key}`);
    }
    if (!['openweathermap', 'custom'].includes(config.weatherProvider)) throw new Error('Invalid weather provider');
    if (
        !['clouds', 'radiation-first'].includes(config.currentSunlightSource) ||
        !['W/m²', 'lux'].includes(config.radiationInputUnit) ||
        config.radiationLuxPerWm2 <= 0 ||
        config.radiationMaxAge <= 0 ||
        config.radiationMinSunElevation < 1 ||
        config.radiationMinSunElevation > 45 ||
        config.radiationRefreshGraceSeconds > 120
    )
        throw new Error('Invalid radiation settings');
    for (const key of [
        'currentRadiationState', 'radiationValidState', 'radiationLastSuccessState',
        'radiationSourcesState', 'radiationStatusState',
    ] as const) {
        if (
            typeof config[key] !== 'string' ||
            (key === 'currentRadiationState' && config.currentSunlightSource === 'radiation-first' && !config[key].trim())
        )
            throw new Error(`Invalid radiation state: ${key}`);
    }
    if (!['coordinates', 'states'].includes(config.sunSource)) throw new Error('Invalid sun source');
    if (config.sunSource === 'states' && (!config.sunAzimuthState || !config.sunElevationState))
        throw new Error('Sun states required');
    for (const key of ['maxTemperatureCurve', 'heatLoadCurve', 'warmNightCurve', 'roomTemperatureCurve'] as const) {
        const curve = config[key];
        if (
            !Array.isArray(curve) ||
            curve.length < 2 ||
            curve.some(
                (p, i) =>
                    !Number.isFinite(p.x) ||
                    !Number.isFinite(p.y) ||
                    p.y < 0 ||
                    p.y > 100 ||
                    (i > 0 && p.x <= curve[i - 1].x),
            )
        )
            throw new Error(`Invalid curve: ${key}`);
    }
    if (
        !Array.isArray(config.shadeLevels) ||
        !config.shadeLevels.length ||
        config.shadeLevels[0].minExposure !== 0 ||
        config.shadeLevels.some(
            (p, i) =>
                !Number.isFinite(p.minExposure) ||
                p.minExposure < 0 ||
                p.minExposure > 100 ||
                !Number.isFinite(p.position) ||
                p.position < 0 ||
                p.position > 100 ||
                (i > 0 &&
                    (p.minExposure <= config.shadeLevels[i - 1].minExposure ||
                        p.position >= config.shadeLevels[i - 1].position)),
        )
    )
        throw new Error('Invalid shade levels');
    if (
        !Array.isArray(config.heatRiskThresholds) ||
        config.heatRiskThresholds.length !== 3 ||
        config.heatRiskThresholds.some(
            (n, i, a) => !Number.isFinite(n) || n <= 0 || n >= 100 || (i > 0 && n <= a[i - 1]),
        )
    )
        throw new Error('Invalid heat thresholds');
    if (
        !Array.isArray(config.daylightMinimumPositions) ||
        config.daylightMinimumPositions.length !== 4 ||
        config.daylightMinimumPositions.some(
            (n, i, a) => !Number.isFinite(n) || n < 0 || n > 100 || (i > 0 && n > a[i - 1]),
        )
    )
        throw new Error('Invalid daylight limits');
    if (
        config.maxTemperatureWeight + config.heatLoadWeight + config.warmNightWeight <= 0 ||
        config.forecastWeight + config.roomTemperatureWeight <= 0
    )
        throw new Error('Weights must have a positive sum');
    if (
        config.cloudAttenuation > 1 ||
        config.futureExposureWeight > 1 ||
        config.evaluationIntervalMinutes <= 0 ||
        config.minPositionChange <= 0
    )
        throw new Error('Invalid interval, change threshold or exposure factor');
    if (
        config.thermalActivationRisk > 100 ||
        config.thermalActivationHysteresis > config.thermalActivationRisk ||
        config.roomOverheatMinimumRisk > 100 ||
        config.emergencyHeatRisk > 100 ||
        config.roomOverheatTemperature > config.emergencyRoomTemperature ||
        config.roomOverheatHysteresis > config.roomOverheatTemperature ||
        config.lowSunFullStrengthElevation <= 0 ||
        config.lowSunFullStrengthElevation > 45 ||
        config.futureExposureHours > 24
    )
        throw new Error('Invalid thermal or solar protection settings');
    if (
        !Array.isArray(config.forecastMapping) ||
        (config.weatherProvider === 'custom' && !config.forecastMapping.length) ||
        config.forecastMapping.some((p) =>
            !p.timeState || !p.temperatureState || (p.cloudsState !== undefined && typeof p.cloudsState !== 'string'),
        )
    )
        throw new Error('Invalid forecast mapping');
    const ids = new Set<string>();
    const outputs = new Set<string>();
    if (!Array.isArray(config.windows)) throw new Error('Invalid windows');
    config.windows = config.windows.map((raw) => {
        const w = { ...windowDefaults, ...raw };
        if (!/^[a-zA-Z0-9_-]+$/.test(w.id) || ids.has(w.id)) throw new Error(`Invalid or duplicate window id: ${w.id}`);
        ids.add(w.id);
        if (!w.blindSetState || !w.blindActualState || !w.roomTemperatureState || outputs.has(w.blindSetState))
            throw new Error(`Missing or duplicate window states: ${w.id}`);
        outputs.add(w.blindSetState);
        if (String(w.contactOpenValue) === String(w.contactClosedValue))
            throw new Error(`Contact open and closed values must differ: ${w.id}`);
        if (!['ignore', 'blockClosing', 'forceOpenWhileOpen'].includes(w.contactMode))
            throw new Error(`Invalid contact mode: ${w.id}`);
        for (const [key, low, high] of [
            ['windowAzimuth', 0, 360],
            ['sunAzimuthMin', 0, 360],
            ['sunAzimuthMax', 0, 360],
            ['sunElevationMin', -90, 90],
            ['sunElevationMax', -90, 90],
            ['morningOpenPosition', 0, 100],
            ['safetyPosition', 0, 100],
            ['temperatureOffset', -50, 50],
            ['heatProtectionOffset', -100, 100],
        ] as const) {
            if (w[key] === ('' as unknown) || w[key] === null) delete w[key];
            const n = w[key];
            if (n !== undefined && (!Number.isFinite(n) || n < low || n > high))
                throw new Error(`Invalid ${key}: ${w.id}`);
        }
        if (
            !Number.isFinite(w.windowAzimuth) ||
            !Number.isFinite(w.temperatureOffset) ||
            !Number.isFinite(w.heatProtectionOffset) ||
            !Number.isFinite(w.morningOpenPosition) ||
            !Number.isFinite(w.safetyPosition)
        )
            throw new Error(`Missing window number: ${w.id}`);
        if (typeof w.enabled !== 'boolean' || typeof w.autoOpenMorning !== 'boolean')
            throw new Error(`Invalid window flag: ${w.id}`);
        return w;
    });
    return config;
}
