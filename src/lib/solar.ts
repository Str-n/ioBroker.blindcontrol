import SunCalc from 'suncalc';
import type { Config, WindowConfig } from './config';
export interface SunPosition {
    azimuth: number;
    elevation: number;
}
export const clamp = (n: number, min = 0, max = 100): number => Math.min(max, Math.max(min, n));
export const angleDistance = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);
export function solarPosition(time: number, latitude: number, longitude: number): SunPosition {
    const p = SunCalc.getPosition(new Date(time), latitude, longitude);
    return {
        azimuth: ((p.azimuth * 180) / Math.PI + 180) % 360,
        elevation: (p.altitude * 180) / Math.PI,
    };
}
export function sunset(time: number, latitude: number, longitude: number): number {
    return SunCalc.getTimes(new Date(time), latitude, longitude).sunset.getTime();
}
export function exposure(sun: SunPosition, clouds: number, w: WindowConfig, c: Config): number {
    if (
        sun.elevation <= 0 ||
        (w.sunElevationMin !== undefined && sun.elevation < w.sunElevationMin) ||
        (w.sunElevationMax !== undefined && sun.elevation > w.sunElevationMax)
    )
        return 0;
    const az = sun.azimuth;
    if (w.sunAzimuthMin !== undefined && w.sunAzimuthMax !== undefined && w.sunAzimuthMin > w.sunAzimuthMax) {
        if (az < w.sunAzimuthMin && az > w.sunAzimuthMax) return 0;
    } else if (
        (w.sunAzimuthMin !== undefined && az < w.sunAzimuthMin) ||
        (w.sunAzimuthMax !== undefined && az > w.sunAzimuthMax)
    )
        return 0;
    const azimuthFactor = Math.max(0, Math.cos((angleDistance(az, w.windowAzimuth) * Math.PI) / 180));
    // Incidence on a vertical facade, with a separate, tunable horizon ramp.
    // The ramp approximates low-sun attenuation; this is an exposure index, not W/m².
    const incidence = azimuthFactor * Math.max(0, Math.cos((sun.elevation * Math.PI) / 180));
    const horizonFactor = clamp(sun.elevation / c.lowSunFullStrengthElevation, 0, 1);
    return clamp(100 * incidence * horizonFactor * (1 - (c.cloudAttenuation * clamp(clouds)) / 100));
}

export function futureSunSamples(
    now: number,
    hours: number,
    latitude: number,
    longitude: number,
    cloudsAt: (time: number) => number,
): { sun: SunPosition; clouds: number }[] {
    const samples = [];
    const end = now + hours * 3600000;
    // Solar geometry changes between the weather provider's three-hour timestamps.
    for (let time = Math.min(now + 10 * 60000, end); time > now; time = Math.min(time + 10 * 60000, end)) {
        samples.push({ sun: solarPosition(time, latitude, longitude), clouds: cloudsAt(time) });
        if (time === end) break;
    }
    return samples;
}
