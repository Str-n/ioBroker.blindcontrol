import type { Config } from './config';
import { clamp, clearSkyIrradiance, type SunPosition } from './solar';
import { numeric, timestamp, type Sample, type Weather } from './weather';

type Quality = 'estimated' | 'lower-bound' | 'cloud-only' | 'unverified';
interface Snapshot {
    irradiance: number;
    sampleTime: number;
    expires: number;
    quality: Quality;
    sources: string;
    status: string;
}
export interface RadiationResult {
    factor: number;
    source: 'radiation' | 'radiation-conservative' | 'clouds' | 'clear-sky-fallback';
    reason: string;
    valid: boolean;
    irradiance: number | null;
    clearSkyIrradiance: number | null;
    normalizedFactor: number | null;
    sampleTime: number | null;
    quality: Quality | 'unavailable';
    sources: string;
    status: string;
    refreshing: boolean;
    retryAt?: number;
}

export function radiationStateIds(c: Config): string[] {
    return c.currentSunlightSource === 'radiation-first'
        ? [
              c.currentRadiationState, c.radiationValidState, c.radiationLastSuccessState,
              c.radiationSourcesState, c.radiationStatusState,
          ].filter(Boolean)
        : [];
}

function fresh(sample: Sample | undefined, now: number, maxAge: number): sample is Sample {
    return !!sample && (sample.q === undefined || sample.q === 0) &&
        Number.isFinite(sample.ts) && sample.ts <= now + 60000 && now - sample.ts <= maxAge * 60000;
}

function readSnapshot(now: number, states: Map<string, Sample>, c: Config): Snapshot {
    const samples: Sample[] = [];
    const read = (id: string, reason: string): Sample => {
        const sample = states.get(id);
        if (!fresh(sample, now, c.radiationMaxAge)) throw new Error(reason);
        samples.push(sample);
        return sample;
    };
    const complete = c.radiationValidState ? read(c.radiationValidState, 'INVALID_VALIDITY') : undefined;
    if (complete && complete.val !== true) throw new Error('PRODUCER_INVALID');
    const signal = read(c.currentRadiationState, 'INVALID_RADIATION');
    const value = numeric(signal, now, c.radiationMaxAge);
    const irradiance = value === undefined
        ? NaN
        : c.radiationInputUnit === 'lux' ? value / c.radiationLuxPerWm2 : value;
    if (!Number.isFinite(irradiance) || irradiance < 0 || irradiance > 1600)
        throw new Error('INVALID_RADIATION');
    let sampleTime = signal.ts;
    if (c.radiationLastSuccessState) {
        const success = read(c.radiationLastSuccessState, 'INVALID_LAST_SUCCESS');
        const time = timestamp(success.val);
        if (!Number.isFinite(time) || time > now + 60000 || now - time > c.radiationMaxAge * 60000)
            throw new Error('INVALID_LAST_SUCCESS');
        if (time < signal.ts - 1000) throw new Error('INCOMPLETE_PUBLICATION');
        sampleTime = Math.min(sampleTime, time);
    }
    let sources: string[] = [];
    if (c.radiationSourcesState) {
        const value = read(c.radiationSourcesState, 'INVALID_SOURCES').val;
        try {
            sources = JSON.parse(String(value));
            if (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string' || !s)) throw new Error();
        } catch {
            throw new Error('INVALID_SOURCES');
        }
    }
    let status = '';
    if (c.radiationStatusState) {
        const value = read(c.radiationStatusState, 'INVALID_STATUS').val;
        if (typeof value !== 'string') throw new Error('INVALID_STATUS');
        status = value;
    }
    // valid=true is the producer's publication boundary; never combine newer fields
    // with an older completion flag. The next completion event triggers evaluation.
    if (complete && samples.some((sample) => sample.ts > complete.ts))
        throw new Error('INCOMPLETE_PUBLICATION');
    let quality: Quality = 'estimated';
    if ((sources.length > 0 && sources.every((s) => s === 'openweather')) || /cloud-only/i.test(status))
        quality = 'cloud-only';
    else if (/clipping|lower-bound/i.test(status)) quality = 'lower-bound';
    else if ((c.radiationSourcesState && sources.length === 0) || /unverified/i.test(status)) quality = 'unverified';
    return {
        irradiance,
        sampleTime,
        expires: Math.min(sampleTime, ...samples.map((s) => s.ts)) + c.radiationMaxAge * 60000,
        quality,
        sources: JSON.stringify(sources),
        status,
    };
}

// Only the last complete publication is cached, without smoothing or extending freshness.
// This cache is intentionally not persisted across adapter restarts.
export class RadiationTracker {
    private committed?: Snapshot;
    private pendingSince?: number;

    evaluate(
        now: number, states: Map<string, Sample>, c: Config, sun: SunPosition | undefined, weather: Weather,
    ): RadiationResult {
        const cloudFactor = 1 - c.cloudAttenuation * clamp(weather.clouds) / 100;
        const result: RadiationResult = {
            factor: cloudFactor,
            source: weather.cloudsSource === 'clear-sky-fallback' ? 'clear-sky-fallback' : 'clouds',
            reason: 'CLOUD_MODE',
            valid: false,
            irradiance: null,
            clearSkyIrradiance: null,
            normalizedFactor: null,
            sampleTime: null,
            quality: 'unavailable',
            sources: '[]',
            status: '',
            refreshing: false,
        };
        if (c.currentSunlightSource !== 'radiation-first') return result;
        let snapshot: Snapshot;
        try {
            snapshot = readSnapshot(now, states, c);
            this.committed = snapshot;
            this.pendingSince = undefined;
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'INVALID_RADIATION';
            result.reason = reason;
            const flag = states.get(c.radiationValidState);
            const publicationPending =
                (reason === 'PRODUCER_INVALID' && flag?.val === false) ||
                reason === 'INCOMPLETE_PUBLICATION';
            if (!publicationPending) {
                this.committed = undefined;
                this.pendingSince = undefined;
                return result;
            }
            // Repeated false writes cannot extend the grace period of one refresh.
            this.pendingSince ??= Math.min(now, reason === 'PRODUCER_INVALID' ? flag!.ts : now);
            const deadline = Math.min(
                this.pendingSince + c.radiationRefreshGraceSeconds * 1000,
                this.committed?.expires ?? now,
            );
            if (!this.committed || now >= deadline || now < this.committed.sampleTime - 60000) {
                this.committed = undefined;
                return result;
            }
            snapshot = this.committed;
            result.refreshing = true;
            result.retryAt = deadline;
        }
        Object.assign(result, {
            valid: true,
            irradiance: snapshot.irradiance,
            sampleTime: snapshot.sampleTime,
            quality: snapshot.quality,
            sources: snapshot.sources,
            status: snapshot.status,
        });
        if (!sun || !Number.isFinite(sun.elevation) || sun.elevation > 90) {
            result.reason = 'SUN_UNAVAILABLE';
            return result;
        }
        result.clearSkyIrradiance = clearSkyIrradiance(sun.elevation);
        if (sun.elevation < c.radiationMinSunElevation) {
            result.reason = 'LOW_SUN';
            return result;
        }
        result.normalizedFactor = clamp(snapshot.irradiance / result.clearSkyIrradiance, 0, 1);
        if (snapshot.quality === 'cloud-only') {
            result.reason = 'CLOUD_ONLY_FALLBACK';
            return result;
        }
        if (snapshot.quality === 'lower-bound' || snapshot.quality === 'unverified') {
            result.factor = Math.max(cloudFactor, result.normalizedFactor);
            result.source = 'radiation-conservative';
            result.reason = snapshot.quality === 'lower-bound'
                ? 'LOWER_BOUND_ONLY_STRENGTHENS' : 'UNVERIFIED_ONLY_STRENGTHENS';
        } else {
            result.factor = result.normalizedFactor;
            result.source = 'radiation';
            result.reason = 'RADIATION_SELECTED';
        }
        if (result.refreshing) result.reason = `REFRESHING_${result.reason}`;
        return result;
    }
}
