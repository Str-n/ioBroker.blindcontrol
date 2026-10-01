# ioBroker.blindcontrol

Forecast-aware sun and heat protection for blinds, based on `SPECIFICATION.md` and its logic-review amendments.
TypeScript / Node.js 20+, ioBroker js-controller 6+ and Admin 7+.

## Build and install

```sh
npm ci
npm test
npm pack
```

Install the resulting `iobroker.blindcontrol-0.1.0.tgz` using your ioBroker installation's local adapter package installation workflow, then create an instance. The package contains the compiled adapter and JSON Admin configuration. It does not start or connect to an ioBroker system during build or tests.

## Commissioning

1. Configure windows in the **Windows** tab. Expand a window by its name to edit its settings. State-ID fields use the full available width; other fields appear in two columns (one on small screens). Each window needs a unique stable `id`, a writable `blindSetState`, a readable `blindActualState`, and a `roomTemperatureState`. Set and actual may be the same state. Positions must be linear percentages: **0 = closed, 100 = open**. Use ioBroker aliases for inverted or differently scaled devices. Temperatures must be Celsius.
2. Select the weather source. The OpenWeatherMap preset reads all 40 `forecast.periodN.date`, `.temperatureMax`, and `.clouds` states in the configured instance (default `openweathermap.0`). The per-period maximum is used as the temperature for heat protection; the preset does not read a nonexistent `.temperature` state or average the minimum and maximum. Enable metric units in that adapter. Custom weather uses a table of timestamp, temperature and optional cloud state IDs. Timestamps accept Unix seconds, milliseconds or date strings (use explicit timezone offsets). Current radiation can optionally replace current cloud attenuation using the **Radiation** tab below.
3. Leave latitude/longitude empty to use ioBroker system coordinates, or supply both. Optionally use external solar states (azimuth: north 0°, east 90°; elevation in degrees). Coordinates remain necessary for forecast solar exposure and computed sunset. An optional sunset state takes precedence for its local date; when sunset is unavailable, vacation uses the latest closing time.
4. Check contact configuration. `contactOpenValue` and `contactClosedValue` default to `true` and `false`; set them to `1`/`0` or your sensor's strings as appropriate. Unknown/stale contact values block movements unless contact mode is `ignore`.
5. Set `control.enabled=true`. **Dry run is initially on**; inspect diagnostics before setting `control.dryRun=false` to allow commands.

The Admin `enabled`, `dryRun`, and window `enabled` / `autoOpenMorning` fields initialize persistent runtime switches only when those states are first created. Later changes use `control.*`, `windows.<id>.enabled` and `windows.<id>.autoOpenMorning`; restarting or saving configuration does not overwrite the resident's runtime choices. Removed windows are no longer evaluated; old states remain for inspection and can be deleted manually.

## VIS dialog integration

In the modified Blinds widget, select **Window automation enabled state**:

```text
blindcontrol.0.windows.living_room.enabled
```

For a shared blind position state, use the main window mapping. For separate sash position states, configure the mapping on each sash. Open the blind dialog, click the settings icon, and switch **Automatic sun and heat protection** on or off. The switch subscribes to the state and waits for an acknowledged value. Errors leave the last confirmed value visible. The **Open automatically in the morning** switch controls the sibling `windows.<id>.autoOpenMorning` state without extra widget mapping. Both settings survive restarts. Vacation mode still overrides the morning preference. Disabling automation retains manual blind controls.

## Runtime and diagnostics

Writable booleans: `control.enabled`, `control.pauseToday`, `control.vacationMode`, `control.dryRun`, `windows.<id>.enabled`, `windows.<id>.autoOpenMorning`, and `windows.<id>.keepClosed`. `pauseToday` clears at local midnight, including when a restart crosses midnight. Calendar calculations use the **adapter host timezone**; configure that timezone to the building's timezone (also in Docker).

For persistent privacy or blackout, close the blind manually and set `windows.<id>.keepClosed=true`. This prevents ordinary and scheduled automatic opening, including vacation morning opening, until cleared. It does not itself close the blind. Contact safety opening can still operate after the minimum manual hold, movement cooldown and earliest opening time. Clearing the switch leaves any other active manual hold in effect.

Global diagnostics under `info` contain activity, last evaluation, forecast validity/risk, 24-hour maximum/minimum/load, outside temperature/cloud cover and next vacation events. `currentOutsideTemperatureSource` reports `observed`, `interpolated` or `unavailable`; `currentCloudCoverSource` reports `observed`, `interpolated` or `clear-sky-fallback`. Every window exposes position, room temperature, solar/decision exposure, heat risk, desired/effective targets, contact, holds, movement times and decision/blocking reasons. `thermalActive`, `roomOverheated` and `openingStableSince` explain the thermal gate and reopening delay. Unavailable numerical inputs are reported as `null`.

`windows.<id>.runtime` stores command identity, command origin/target, completion, manual hold and position, last auto/manual actions, hysteresis bands and daily event markers as one acknowledged JSON state. Diagnostic mirrors include `commandId`, `commandTimestamp` and `targetPosition`. Runtime is saved before a device command, preserving cooldown even if the process exits or command delivery fails. Failed writes report `COMMAND_FAILED` and retain the cooldown because delivery might have occurred.

## Optional radiation-first control

In the **Radiation** tab, set `currentSunlightSource` to `radiation-first`. The default remains `clouds` for existing behavior. The prefilled states consume the outdoor brightness model:

| Setting | Default state |
| --- | --- |
| `currentRadiationState` | `0_userdata.0.sunlight.overall.irradiance_estimated` |
| `radiationValidState` | `0_userdata.0.sunlight.overall.valid` |
| `radiationLastSuccessState` | `0_userdata.0.sunlight.overall.last_success` |
| `radiationSourcesState` | `0_userdata.0.sunlight.overall.sources_used` |
| `radiationStatusState` | `0_userdata.0.sunlight.overall.status` |

Use `radiationInputUnit=W/m²` for that companion state. To use `0_userdata.0.sunlight.overall.estimated` instead, select `lux`; `radiationLuxPerWm2` defaults to 120. Match it to the producer's conversion, including any lux calibration multiplier. The W/m² state avoids this conversion and lux rounding. For a standalone sensor, change the input state and clear metadata state IDs that the sensor does not provide. All configured metadata fields are validated: boolean validity, timestamp of last success, JSON array of source names, and status text. Model source metadata identifies OpenWeather-only, clipped PV, and unverified fallback estimates.

The current estimate is normalized by Haurwitz clear-sky horizontal irradiance at the current solar elevation, then bounded to 0–1. That factor **replaces** the current cloud attenuation in the window's existing geometry calculation. Window orientation, obstructions, thermal demand, overheating protection and all movement/manual/contact guards still apply. Below `radiationMinSunElevation=5°`, clouds are used to avoid an unstable ratio and modelled twilight. This remains a heuristic for window exposure: horizontal radiation includes diffuse light and is not a calibrated measurement of heat entering a vertical window.

Inputs must be finite, non-negative and at most 1600 W/m² after conversion, with good ioBroker quality and fresh timestamps. `radiationMaxAge=25` is in minutes. Missing, invalid or stale input falls back to current cloud control, including its conservative clear-sky fallback. OpenWeather-only model results also use cloud control. Clipped/lower-bound or unverified results can only increase protection relative to the cloud-based exposure; a low estimate from those sources cannot weaken it. Zero is a valid reading when its metadata is valid.

The model publishes `valid=false` during refresh and `valid=true` after its output and metadata are complete. The adapter accepts completed publications and can retain the last complete, still-fresh snapshot for at most `radiationRefreshGraceSeconds=30` while a refresh is pending. Repeated invalid writes do not renew this grace or the original data age. Expiry schedules a new evaluation; unresolved failure then falls back to clouds. There is no additional brightness smoothing, and the publication cache is cleared on adapter restart. Ordinary reopening still requires its existing stability period.

Forecast temperatures remain mandatory for thermal risk, independently of cloud availability. Missing/bad cloud samples leave their forecast intervals unavailable for predictive exposure, while temperature processing continues. Current radiation is not projected into the coming hours: available forecast clouds still control predictive exposure. At high heat risk, forecast sunshine can therefore retain shading despite low current radiation.

For commissioning, enable dry run and compare `windows.<id>.solarExposure` / `desiredPosition` with `cloudBasedSolarExposure` / `cloudBasedTargetPosition`. The reference calculation uses the same current runtime and forecast, without updating a second controller. `info.currentSunlightSource` identifies `radiation`, `radiation-conservative`, `clouds` or `clear-sky-fallback`; `currentSunlightFactor` shows the applied multiplier. Other diagnostics include `radiationReason`, `radiationValid`, `radiationIrradiance`, `radiationClearSkyIrradiance`, `radiationNormalizedFactor`, `radiationSampleTime`, `radiationQuality`, `radiationSources`, `radiationStatus` and `radiationRefreshing`. `radiationValid` describes the accepted snapshot; the source/reason states explain whether it is used. `forecastCloudsValid` reports complete cloud coverage across the accepted temperature points, and `futureExposureSampleCount` shows the number of usable upcoming solar samples.

## Decision details

- Forecast selection is timestamp-based for the next 24 hours. A valid temperature forecast must start within 3.5 hours, reach within 3.5 hours of the end, and have no gaps above 3.5 hours. Invalid/stale required inputs produce no movements. Quality flags other than zero are rejected. Optional cloud/radiation data use the availability and fallback rules described above.
- Heat load integrates each sample forward to the next (last sample up to three hours, clipped at 24 hours). Night is 22:00–07:00 local time. Configurable temperature/load/night curves and normalized weights determine risk. Each forecast hour below `coolingTemperature` subtracts `coolingReductionPerHour` points.
- Current weather prefers valid observations. Otherwise it interpolates between surrounding forecast samples, retaining recent past samples for that purpose. It never substitutes a future sample for current conditions. Without surrounding samples, current temperature is unknown and cloud cover conservatively falls back to clear sky. Unknown current temperature disables evening relaxation, while forecast heat protection continues. The evening trend compares current temperature with an interpolated value exactly three hours ahead.
- Exposure uses vertical-facade incidence: `cos(azimuth difference) × cos(elevation)`, continuous cloud attenuation, and a separate linear horizon ramp reaching full strength at `lowSunFullStrengthElevation` (10° by default). This is a tunable exposure index, not a calibrated irradiance measurement. Optional azimuth limits can cross north. High/very-high heat bands include future exposure within `futureExposureHours`, sampling solar geometry every ten minutes and at the horizon endpoint, with interpolated clouds. Lower bands prioritize daylight.
- Heat shading activates at `thermalActivationRisk=20` and deactivates below 15 (`thermalActivationHysteresis=5`). With no thermal demand the heat-control target is fully open; schedules and manual preferences still apply. There is no separate glare-control mode.
- At `roomOverheatTemperature=26°C`, measured room temperature independently enforces `roomOverheatMinimumRisk=75`, even with a cool forecast. This floor releases below 25.5°C (`roomOverheatHysteresis=0.5`). At `emergencyRoomTemperature=28°C`, the risk is at least `emergencyHeatRisk=90`. Temperature offsets apply before these comparisons. Disabling emergency leaves these thermal floors intact and retains the normal movement interval.
- Configurable shade levels, heat bands, daylight floors and hysteresis limit adjustments. Very hot south-facing windows can close completely. Evening cooling relaxes the **thermal target** by one configured position step and approaches that stable target at most one step per movement. Reaching the target does not trigger further opening or a return to stronger shading under unchanged conditions.
- Normal movements require 60 minutes between commands per window and a 10-point difference by default. Ordinary opening additionally requires the same proposed position for `openingStabilityMinutes=20`. A changed target, interrupted eligibility, a gap longer than twice the evaluation interval (at least one minute), or an adapter restart starts fresh evidence collection. A brief cloud therefore does not open the blind and start a closing cooldown. Scheduled morning and contact safety opening skip this weather-stability delay. Emergency only shortens the interval for additional closing; it never bypasses a manual minimum hold or contact safety.
- Manual input is inferred from setpoint writes or actual movement outside an outstanding command's plausible trajectory/time window. Tolerances suppress feedback noise. A reversal, different requested target or late movement starts a hold. Within a recognised self-action window, identical target commands cannot be distinguished from the adapter's own echoes. Configure the timeout to cover the motor's travel time.
- Manual holds last at least 60 minutes and continue at low exposure. Manual closing also prevents ordinary reopening in sunshine; additional automatic closing retains that preference. A morning or vacation closing event scheduled **after** the manual action releases the extended hold once its minimum duration has expired. An overdue event scheduled before the manual action cannot undo it. With morning opening disabled, a closing preference can remain until another manual action or a later vacation event. `keepClosed` explicitly preserves privacy across scheduled openings. A detected offline position change conservatively starts a new hold at startup. Startup delay defaults to 30 seconds.
- Morning opening respects `autoOpenMorning` and is capped by heat protection. A window that opted out is not opened by generic daytime logic unless the adapter already managed it that day. Vacation overrides the morning opt-out and closes after sunset plus offset, capped by the latest closing time. Pending events retry after higher-priority holds.
- Global disable/pause and invalid required inputs always block movement. `forceOpenWhileOpen` requests at least the safety position and never closes an already more-open blind; manual minimum holds, movement interval and earliest opening still apply. Contact safety opening can operate outside the normal control period.
- Changes are coalesced; evaluations and state handling are serialized. Input changes received while an evaluation awaits database writes cancel that evaluation's stale command.

Time values ending in `Minutes` are minutes; `selfActionRecognitionTimeout` and `startupDelaySeconds` are seconds. **All `*MaxAge` values are minutes**, measured from state `ts`, not `lc`, and should accommodate sensors that only report changes.

Existing runtime states migrate automatically. A restart preserves manual intent and thermal hysteresis, but resets opening-stability evidence. New blocking reasons include `OPENING_NOT_STABLE`, `MANUAL_CLOSED` and `KEEP_CLOSED`; `NO_THERMAL_DEMAND` identifies a fully open heat-control target. Existing installations inherit the new settings when absent from their saved configuration. Generated package defaults now also match the temperature curves already declared in `src/lib/config.ts`; saved instance curves remain unchanged. Check the revised targets in dry run: facade geometry and room-temperature floors intentionally change shading behavior.

## Development and tests

```sh
npm run build
node scripts/generate-admin.cjs  # regenerate native defaults and Admin tabs after config changes
npm test
```

`src/lib/engine.ts`, `weather.ts`, `solar.ts` and `radiation.ts` are independent of ioBroker. Unit tests cover decision rules, forecast interpolation, radiation selection/publication/freshness, facade geometry, thermal hysteresis, manual recognition and configuration validation, including multi-evaluation cloud and evening sequences. Adapter tests use an in-memory ioBroker stand-in to exercise radiation fallback/comparison, persistence, runtime migration, privacy switches, reopening evidence, startup, acknowledgement, dry-run, failed commands and stale-input cancellation. No test sends commands to real blinds.

The OpenWeatherMap mapping follows its [adapter implementation](https://github.com/ioBroker/ioBroker.openweathermap/blob/master/src/main.ts). Admin configuration follows the [ioBroker JSON Config format](https://github.com/ioBroker/ioBroker.admin/blob/master/packages/jsonConfig/README.md).
