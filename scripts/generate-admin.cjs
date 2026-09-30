const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { defaults, windowDefaults } = require('../build/lib/config');
const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
const pkg = require('../package.json');
write('io-package.json', {
    common: {
        name: 'blindcontrol',
        version: pkg.version,
        titleLang: { en: 'Blind control', de: 'Rollladensteuerung' },
        desc: {
            en: pkg.description,
            de: 'Wetterabhängiger Sonnen- und Hitzeschutz für Rollläden',
        },
        authors: ['Nils'],
        license: 'MIT',
        platform: 'Javascript/Node.js',
        mode: 'daemon',
        main: 'build/main.js',
        icon: 'blindcontrol.svg',
        enabled: true,
        compact: true,
        connectionType: 'local',
        dataSource: 'push',
        type: 'climate-control',
        adminUI: { config: 'json' },
        dependencies: [{ 'js-controller': '>=6.0.0' }],
        globalDependencies: [{ admin: '>=7.0.0' }],
    },
    native: defaults,
    objects: [],
    instanceObjects: [],
});
const select = (values) => ({
    type: 'select',
    options: values.map((value) => ({ label: value, value })),
});
const items = {};
const tabs = {
    General: [
        'enabled',
        'dryRun',
        'controlStart',
        'controlEnd',
        'earliestAutoOpen',
        'evaluationIntervalMinutes',
        'minAutoMovementIntervalMinutes',
        'minPositionChange',
        'startupDelaySeconds',
    ],
    Weather: [
        'weatherProvider',
        'openWeatherMapInstance',
        'currentOutsideTemperatureState',
        'currentCloudCoverState',
        'forecastMapping',
        'heatLoadBaseTemperature',
        'coolingTemperature',
        'coolingReductionPerHour',
        'maxTemperatureCurve',
        'heatLoadCurve',
        'warmNightCurve',
        'maxTemperatureWeight',
        'heatLoadWeight',
        'warmNightWeight',
        'forecastWeight',
        'roomTemperatureWeight',
    ],
    Sun: [
        'sunSource',
        'latitude',
        'longitude',
        'sunAzimuthState',
        'sunElevationState',
        'sunsetState',
        'cloudAttenuation',
        'futureExposureHours',
        'futureExposureWeight',
    ],
    Shading: [
        'shadeLevels',
        'heatRiskThresholds',
        'daylightMinimumPositions',
        'roomTemperatureCurve',
        'southTolerance',
        'extremeHeatExposure',
        'eveningStart',
        'eveningCoolingDelta',
        'eveningCriticalRoomTemperature',
        'solarExposureHysteresis',
        'heatRiskHysteresis',
    ],
    Manual: [
        'manualHoldMinutes',
        'manualHoldLowExposureThreshold',
        'manualDetectionTolerance',
        'selfActionRecognitionTimeout',
    ],
    Emergency: ['emergencyEnabled', 'emergencyRoomTemperature', 'emergencyHeatRisk', 'emergencyMinMovementInterval'],
    Vacation: ['vacationSunsetOffsetMinutes', 'vacationLatestCloseTime'],
    Data: [
        'sunPositionMaxAge',
        'weatherCurrentMaxAge',
        'forecastMaxAge',
        'roomTemperatureMaxAge',
        'blindPositionMaxAge',
        'contactMaxAge',
    ],
    Windows: ['windows'],
};
const table = (columns, template = {}) => ({
    type: 'table',
    sm: 12,
    items: columns.map((attr) => ({
        attr,
        title: attr,
        type: attr.endsWith('State')
            ? 'objectId'
            : typeof template[attr] === 'boolean'
              ? 'checkbox'
              : typeof template[attr] === 'number'
                ? 'number'
                : 'text',
        default: template[attr] ?? '',
        width: attr.endsWith('State') ? 240 : 140,
    })),
});
const custom = {
    weatherProvider: select(['openweathermap', 'custom']),
    sunSource: select(['coordinates', 'states']),
    forecastMapping: table(['timeState', 'temperatureState', 'cloudsState']),
    shadeLevels: table(['name', 'minExposure', 'position'], {
        name: '',
        minExposure: 0,
        position: 100,
    }),
    windows: table(
        [
            'id',
            'name',
            'enabled',
            'blindSetState',
            'blindActualState',
            'roomTemperatureState',
            'contactState',
            'contactMode',
            'contactOpenValue',
            'contactClosedValue',
            'safetyPosition',
            'windowAzimuth',
            'sunAzimuthMin',
            'sunAzimuthMax',
            'sunElevationMin',
            'sunElevationMax',
            'autoOpenMorning',
            'morningOpenPosition',
            'temperatureOffset',
            'heatProtectionOffset',
        ],
        windowDefaults,
    ),
};
for (const key of ['maxTemperatureCurve', 'heatLoadCurve', 'warmNightCurve', 'roomTemperatureCurve'])
    custom[key] = table(['x', 'y'], { x: 0, y: 0 });
for (const column of custom.windows.items) {
    if (column.attr === 'contactMode') Object.assign(column, select(['ignore', 'blockClosing', 'forceOpenWhileOpen']));
    if (/^sun(Azimuth|Elevation)/.test(column.attr)) column.type = 'number';
}
// Windows have too many settings for a single table row. Keep the same array
// and attribute names, but let each window expand into a responsive form.
const windowLabels = {
    id: { en: 'Window ID', de: 'Fenster-ID' },
    name: { en: 'Window name', de: 'Fenstername' },
    enabled: { en: 'Initially enabled', de: 'Anfangs aktiviert' },
    blindSetState: { en: 'Blind target position state', de: 'Datenpunkt für die Rollladen-Sollposition' },
    blindActualState: { en: 'Blind actual position state', de: 'Datenpunkt für die Rollladen-Istposition' },
    roomTemperatureState: { en: 'Room temperature state', de: 'Datenpunkt für die Raumtemperatur' },
    contactState: { en: 'Window / door contact state (optional)', de: 'Datenpunkt für Fenster-/Türkontakt (optional)' },
    contactMode: { en: 'Contact safety mode', de: 'Sicherheitsmodus des Kontakts' },
    contactOpenValue: { en: 'Contact value when open', de: 'Kontaktwert bei geöffnetem Fenster' },
    contactClosedValue: { en: 'Contact value when closed', de: 'Kontaktwert bei geschlossenem Fenster' },
    safetyPosition: { en: 'Safety opening position (%)', de: 'Sicherheitsposition (%)' },
    windowAzimuth: { en: 'Window direction (°)', de: 'Fensterausrichtung (°)' },
    sunAzimuthMin: { en: 'Minimum sun azimuth (°, optional)', de: 'Minimaler Sonnenazimut (°, optional)' },
    sunAzimuthMax: { en: 'Maximum sun azimuth (°, optional)', de: 'Maximaler Sonnenazimut (°, optional)' },
    sunElevationMin: { en: 'Minimum sun elevation (°, optional)', de: 'Minimale Sonnenhöhe (°, optional)' },
    sunElevationMax: { en: 'Maximum sun elevation (°, optional)', de: 'Maximale Sonnenhöhe (°, optional)' },
    autoOpenMorning: { en: 'Initially open automatically in the morning', de: 'Anfangs morgens automatisch öffnen' },
    morningOpenPosition: { en: 'Morning opening position (%)', de: 'Öffnungsposition am Morgen (%)' },
    temperatureOffset: { en: 'Room temperature correction (°C)', de: 'Korrektur der Raumtemperatur (°C)' },
    heatProtectionOffset: { en: 'Heat-risk correction (points)', de: 'Korrektur des Hitzerisikos (Punkte)' },
};
custom.windows = {
    type: 'accordion',
    label: { en: 'Windows', de: 'Fenster' },
    titleAttr: 'name',
    xs: 12,
    sm: 12,
    items: custom.windows.items.map(({ width, title, ...field }) => ({
        ...field,
        label: windowLabels[field.attr],
        xs: 12,
        sm: field.type === 'objectId' ? 12 : 6,
        newLine:
            field.type === 'objectId' ||
            [
                'id',
                'windowAzimuth',
                'sunAzimuthMin',
                'sunElevationMin',
                'autoOpenMorning',
                'temperatureOffset',
            ].includes(field.attr),
    })),
};
for (const [tab, keys] of Object.entries(tabs)) {
    const fields = {};
    for (const key of keys) {
        const value = defaults[key];
        fields[key] = {
            label: key,
            sm: 6,
            type:
                typeof value === 'boolean'
                    ? 'checkbox'
                    : typeof value === 'number'
                      ? 'number'
                      : Array.isArray(value)
                        ? 'jsonEditor'
                        : key.endsWith('State')
                          ? 'objectId'
                          : 'text',
            ...custom[key],
        };
    }
    items[`_${tab}`] = { type: 'panel', label: tab, items: fields };
}
items._General.items._help = {
    type: 'staticText',
    text: 'enabled and dryRun are initial defaults. Change the persistent control.* states at runtime. All times use the adapter host timezone; positions: 0 = closed, 100 = open.',
    sm: 12,
};
items._Data.items._help = {
    type: 'staticText',
    text: 'All maximum data ages are in minutes (state ts, not lc). Zero requires a fresh sample. Configure generous ages for sensors that report only changes.',
    sm: 12,
};
items._Windows.items._help = {
    type: 'staticText',
    text: 'Expand a window to edit its settings. Use stable unique IDs. enabled and autoOpenMorning are initial values; runtime switches retain changes from the dialog. Map windows.<id>.enabled in the VIS widget. All temperatures must be Celsius; positions must be linear 0–100 (use ioBroker aliases for other units).',
    sm: 12,
};
items._Sun.items._help = {
    type: 'staticText',
    text: 'Leave coordinates empty to use system.config. State azimuth: north=0°, east=90°. Coordinates are also used for future exposure and sunset. Without a sunset at polar latitudes, the latest vacation closing time is used.',
    sm: 12,
};
items._Windows.label = { en: 'Windows', de: 'Fenster' };
write('admin/jsonConfig.json', { type: 'tabs', i18n: false, items });
