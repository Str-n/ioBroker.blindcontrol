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
    const elevationFactor = Math.min(1, Math.sin((sun.elevation * Math.PI) / 180) / Math.sin(Math.PI / 4));
    return clamp(100 * azimuthFactor * elevationFactor * (1 - (c.cloudAttenuation * clamp(clouds)) / 100));
}
