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
2. Select the weather source. The OpenWeatherMap preset reads all 40 `forecast.periodN.date`, `.temperatureMax`, and `.clouds` states in the configured instance (default `openweathermap.0`). The per-period maximum is used as the temperature for heat protection; the preset does not read a nonexistent `.temperature` state or average the minimum and maximum. Enable metric units in that adapter. Custom weather uses a table of timestamp, temperature and cloud state IDs. Timestamps accept Unix seconds, milliseconds or date strings (use explicit timezone offsets).
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

## Decision details

- Forecast selection is timestamp-based for the next 24 hours. A valid forecast must start within 3.5 hours, reach within 3.5 hours of the end, and have no gaps above 3.5 hours. Invalid/stale inputs produce no movements. Quality flags other than zero are rejected.
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

`src/lib/engine.ts`, `weather.ts` and `solar.ts` are independent of ioBroker. Unit tests cover decision rules, forecast interpolation, facade geometry, thermal hysteresis, manual recognition and configuration validation, including multi-evaluation cloud and evening sequences. Adapter tests use an in-memory ioBroker stand-in to exercise persistence, runtime migration, privacy switches, reopening evidence, startup, acknowledgement, dry-run, failed commands and stale-input cancellation. No test sends commands to real blinds.

The OpenWeatherMap mapping follows its [adapter implementation](https://github.com/ioBroker/ioBroker.openweathermap/blob/master/src/main.ts). Admin configuration follows the [ioBroker JSON Config format](https://github.com/ioBroker/ioBroker.admin/blob/master/packages/jsonConfig/README.md).
