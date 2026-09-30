import type { Config, CurvePoint, ForecastMapping } from './config';
import { clamp } from './solar';
export interface Sample {
    val: unknown;
    ts: number;
    q?: number;
}
export interface ForecastPoint {
    time: number;
    temperature: number;
    clouds: number;
}
export interface Weather {
    valid: boolean;
    points: ForecastPoint[];
    risk: number;
    max: number;
    min: number;
    heatLoad: number;
    coolingHours: number;
    outside: number;
    clouds: number;
}
export function numeric(s: Sample | undefined, now: number, maxAgeMinutes: number): number | undefined {
    if (
        !s ||
        (s.q !== undefined && s.q !== 0) ||
        !Number.isFinite(s.ts) ||
        s.ts > now + 60000 ||
        now - s.ts > maxAgeMinutes * 60000 ||
        typeof s.val !== 'number' ||
        !Number.isFinite(s.val)
    )
        return undefined;
    return s.val;
}
export function timestamp(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
    if (typeof value === 'string' && value.trim()) {
        if (/^\d+(\.\d+)?$/.test(value)) return timestamp(Number(value));
        return Date.parse(value);
    }
    return NaN;
}
export function interpolate(value: number, curve: CurvePoint[]): number {
    if (value <= curve[0].x) return curve[0].y;
    for (let i = 1; i < curve.length; i++) {
        if (value <= curve[i].x) {
            const a = curve[i - 1],
                b = curve[i];
            return a.y + ((b.y - a.y) * (value - a.x)) / (b.x - a.x);
        }
    }
    return curve[curve.length - 1].y;
}
export function forecastMappings(c: Config): ForecastMapping[] {
    return c.weatherProvider === 'custom'
        ? c.forecastMapping
        : Array.from({ length: 40 }, (_, i) => ({
              timeState: `${c.openWeatherMapInstance}.forecast.period${i}.date`,
              // OpenWeatherMap exposes temperatureMin/temperatureMax, not temperature.
              temperatureState: `${c.openWeatherMapInstance}.forecast.period${i}.temperatureMax`,
              cloudsState: `${c.openWeatherMapInstance}.forecast.period${i}.clouds`,
          }));
}
export function prepareWeather(now: number, states: Map<string, Sample>, c: Config): Weather {
    const points: ForecastPoint[] = [];
    for (const m of forecastMappings(c)) {
        const timeSample = states.get(m.timeState);
        const time = timestamp(timeSample?.val);
        const temperature = numeric(states.get(m.temperatureState), now, c.forecastMaxAge);
        const clouds = numeric(states.get(m.cloudsState), now, c.forecastMaxAge);
        if (
            !timeSample ||
            (timeSample.q || 0) !== 0 ||
            !Number.isFinite(timeSample.ts) ||
            timeSample.ts > now + 60000 ||
            now - timeSample.ts > c.forecastMaxAge * 60000 ||
            !Number.isFinite(time) ||
            temperature === undefined ||
            temperature < -90 ||
            temperature > 65 ||
            clouds === undefined ||
            clouds < 0 ||
            clouds > 100
        )
            continue;
        if (time >= now && time <= now + 86400000) points.push({ time, temperature, clouds });
    }
    const unique = [...new Map(points.map((p) => [p.time, p])).values()].sort((a, b) => a.time - b.time);
    // A 3-hour forecast must actually cover the next day, not just a single hot point.
    const valid =
        unique.length >= 2 &&
        unique[0].time - now <= 3.5 * 3600000 &&
        now + 86400000 - unique.at(-1)!.time <= 3.5 * 3600000 &&
        unique.every((p, i) => !i || p.time - unique[i - 1].time <= 3.5 * 3600000);
    const temperatures = unique.map((p) => p.temperature);
    const max = temperatures.length ? Math.max(...temperatures) : NaN;
    const min = temperatures.length ? Math.min(...temperatures) : NaN;
    let heatLoad = 0,
        coolingHours = 0;
    unique.forEach((p, i) => {
        const hours =
            Math.max(0, Math.min(unique[i + 1]?.time ?? p.time + 3 * 3600000, now + 86400000) - p.time) / 3600000;
        heatLoad += Math.max(0, p.temperature - c.heatLoadBaseTemperature) * hours;
        if (p.temperature < c.coolingTemperature) coolingHours += hours;
    });
    const night = unique.filter((p) => {
        const hour = new Date(p.time).getHours();
        return hour >= 22 || hour < 7;
    });
    const nightMin = night.length ? Math.min(...night.map((p) => p.temperature)) : min;
    const totalWeight = c.maxTemperatureWeight + c.heatLoadWeight + c.warmNightWeight;
    const risk = clamp(
        (interpolate(max, c.maxTemperatureCurve) * c.maxTemperatureWeight +
            interpolate(heatLoad, c.heatLoadCurve) * c.heatLoadWeight +
            interpolate(nightMin, c.warmNightCurve) * c.warmNightWeight) /
            totalWeight -
            coolingHours * c.coolingReductionPerHour,
    );
    const outsideValue = numeric(states.get(c.currentOutsideTemperatureState), now, c.weatherCurrentMaxAge);
    const cloudValue = numeric(states.get(c.currentCloudCoverState), now, c.weatherCurrentMaxAge);
    const outside =
        outsideValue !== undefined && outsideValue >= -90 && outsideValue <= 65
            ? outsideValue
            : (unique[0]?.temperature ?? NaN);
    const clouds =
        cloudValue !== undefined && cloudValue >= 0 && cloudValue <= 100 ? cloudValue : (unique[0]?.clouds ?? NaN);
    return {
        valid,
        points: unique,
        risk,
        max,
        min,
        heatLoad,
        coolingHours,
        outside,
        clouds,
    };
}
