# Spezifikation ioBroker-Adapter – Sonnen- und Hitzeschutzsteuerung für Rollläden

## 1. Ziel

Der Adapter steuert Rollläden abhängig von:

- Sonnenstand
- Fensterausrichtung
- aktueller Bewölkung
- Wettervorhersage der kommenden 24 Stunden
- aktueller Raumtemperatur
- optionaler Verschattung des jeweiligen Fensters
- Tageszeit
- manuellen Eingriffen
- Fenster-/Türkontakten
- Urlaubsmodus

Primäres Ziel ist die Vermeidung einer unnötigen Aufheizung der Räume.

Gleichzeitig soll möglichst viel Tageslicht erhalten bleiben. Eine starke oder vollständige Verschattung erfolgt deshalb nur, wenn die thermische Situation bzw. Wetterprognose dies rechtfertigt.

Die Automatik soll sich ruhig und vorhersehbar verhalten. Unnötige Rollladenfahrten und häufiges Nachregeln sind zu vermeiden.

---

# 2. Technische Grundlage

Der Adapter wird als eigenständiger ioBroker-Adapter implementiert.

Technologie:

- TypeScript
- Node.js
- `@iobroker/adapter-core`
- ioBroker JSON Config für die Admin-Oberfläche
- persistente ioBroker-States für Laufzeitinformationen und Zustände
- Unit-Tests für die Entscheidungslogik

Die eigentliche Entscheidungslogik ist unabhängig von der ioBroker-Ansteuerung zu implementieren, damit sie isoliert getestet werden kann.

Architektur:

1. Input-/State-Schicht
2. Wetteraufbereitung
3. Sonnenstands-/Expositionsberechnung
4. Heat-Risk-Berechnung
5. Entscheidungslogik
6. Sperr- und Sicherheitslogik
7. Rollladenansteuerung
8. Diagnose

---

# 3. Positionsdefinition

Für alle Rollläden gilt:

- `0 %` = vollständig geschlossen
- `100 %` = vollständig geöffnet

Zwischenpositionen sind zulässig.

Der Adapter geht grundsätzlich von einer linearen Prozentposition aus.

---

# 4. Laufzeitmodi

Der Adapter stellt mindestens folgende beschreibbare States bereit:

```text
control.enabled
control.pauseToday
control.vacationMode
control.dryRun
```

## 4.1 control.enabled

Globaler Hauptschalter.

### `false`

Der Adapter führt keinerlei automatische Rollladenbewegungen durch.

Berechnungen und Diagnose dürfen weiterlaufen.

### `true`

Die Automatik ist grundsätzlich freigegeben.

---

## 4.2 control.pauseToday

Temporäre Deaktivierung für den aktuellen Kalendertag.

Bei:

```text
pauseToday = true
```

werden keine automatischen Bewegungen ausgeführt.

Der State wird um 00:00 Uhr lokaler Zeit automatisch auf `false` zurückgesetzt.

Der Adapter speichert zusätzlich das Datum der Aktivierung, damit ein Neustart über Mitternacht korrekt behandelt wird.

---

## 4.3 control.vacationMode

Im Urlaubsmodus gelten grundsätzlich dieselben Hitzeschutzregeln.

Zusätzlich:

- werden morgens alle aktivierten Rollläden automatisch berücksichtigt,
- unabhängig von deren Einstellung `autoOpenMorning`,
- werden abends alle aktivierten Rollläden automatisch geschlossen.

Der Urlaubsmodus ersetzt nicht den Hitzeschutz, sondern ergänzt ihn.

---

## 4.4 control.dryRun

Testbetrieb.

Bei `true`:

- sämtliche Berechnungen werden durchgeführt,
- Zielpositionen werden berechnet,
- Sperren werden ausgewertet,
- Diagnose-States werden aktualisiert,
- es werden jedoch keine Befehle an Rollläden gesendet.

Dieser Modus dient insbesondere zur Inbetriebnahme und Parameteroptimierung.

---

# 5. Priorität der Regeln

Die Regeln werden in folgender Reihenfolge ausgewertet:

1. `control.enabled`
2. `control.pauseToday`
3. Verfügbarkeit und Gültigkeit der benötigten Eingangsdaten
4. Fenster aktiviert/deaktiviert
5. Tür-/Fenstersicherheit
6. manuelle Sperre
7. Mindestzeit seit letzter automatischer Bewegung
8. Urlaubsmodus-Auf-/Zu-Regeln
9. Hitzeschutz
10. Abendlockerung
11. Mindestpositionsänderung
12. Ausgabe des Fahrbefehls

Eine Regel mit höherer Priorität kann eine Regel mit niedrigerer Priorität blockieren.

---

# 6. Globale Zeitsteuerung

Folgende Parameter werden global konfiguriert:

```text
controlStart
controlEnd
earliestAutoOpen
```

## controlStart / controlEnd

Innerhalb dieses Zeitraums arbeitet die normale Sonnen-/Hitzeschutzsteuerung.

Außerhalb dieses Zeitraums werden vorhandene Positionen nicht verändert.

Ausnahmen sind explizite Urlaubsmodus-Auf-/Zu-Ereignisse.

## earliestAutoOpen

Vor dieser Zeit darf der Adapter niemals selbstständig einen Rollladen öffnen.

Automatisches Schließen zum Hitzeschutz darf dagegen bereits früher erfolgen.

---

# 7. Bewertungsintervall

Standard:

```text
evaluationIntervalMinutes = 5
```

Alle fünf Minuten wird die Situation neu berechnet.

Zusätzlich kann eine Neubewertung durch relevante State-Änderungen ausgelöst werden.

Eine Neubewertung bedeutet ausdrücklich nicht automatisch eine Rollladenfahrt.

Sperrzeiten und Hysterese gelten weiterhin.

---

# 8. Mindestzeit zwischen automatischen Bewegungen

Standard:

```text
minAutoMovementIntervalMinutes = 60
```

Diese Sperre gilt separat für jedes Fenster.

Nach einer automatischen Bewegung darf derselbe Rollladen normalerweise mindestens 60 Minuten nicht erneut automatisch verstellt werden.

Andere Rollläden sind davon nicht betroffen.

---

# 9. Mindestpositionsänderung

Kleine Positionskorrekturen sollen vermieden werden.

Standard:

```text
minPositionChange = 10
```

Eine Änderung wird nur ausgeführt, wenn zwischen aktueller Position und Zielposition mindestens 10 Prozentpunkte liegen.

Beispiel:

```text
Ist: 50 %
Soll: 55 %
```

Keine Bewegung.

```text
Ist: 50 %
Soll: 70 %
```

Bewegung grundsätzlich zulässig.

---

# 10. Wetterdaten

## 10.1 Wetterprovider-Abstraktion

Der Adapter wird nicht fest an einen einzelnen Wetteradapter gekoppelt.

Er enthält jedoch ein Preset für:

```text
openweathermap
```

Standard-Pfad:

```text
openweathermap.0.forecast
```

Die konkrete Instanz muss konfigurierbar sein.

Darüber hinaus soll eine benutzerdefinierte State-Zuordnung möglich sein.

---

# 11. OpenWeatherMap-Prognose

Vorhandene Prognose:

```text
openweathermap.0.forecast.period0
...
openweathermap.0.forecast.period39
```

Ein Periodeneintrag repräsentiert etwa drei Stunden.

Der Adapter wertet nicht pauschal `period0` bis `period7` aus, sondern verwendet die Zeitstempel der Perioden.

Berücksichtigt werden alle Prognosepunkte mit:

```text
now <= forecastTime <= now + 24h
```

Damit bleibt die Berechnung auch dann korrekt, wenn `period0` zeitlich nicht exakt mit der aktuellen Uhrzeit beginnt.

---

# 12. Wettergrößen

Mindestens erforderlich:

- Prognosezeitpunkt
- Temperatur
- Bewölkung

Optional bzw. empfohlen:

- aktuelle Außentemperatur
- aktuelle Bewölkung

Falls keine aktuellen Werte vorhanden sind, darf der zeitlich nächste Prognosewert verwendet werden.

---

# 13. Thermische 24-Stunden-Bewertung

Die Entscheidung basiert ausdrücklich nicht nur auf der maximal vorhergesagten Temperatur.

Beispiel:

### Herbst

```text
Maximum: 25 °C
Nachtminimum: 10 °C
```

→ vergleichsweise geringe thermische Belastung.

### Sommer

```text
Maximum: 25 °C
Nachtminimum: 20 °C
```

→ deutlich höhere thermische Belastung.

Der zweite Fall muss deshalb zu stärkerem Hitzeschutz führen.

---

# 14. ForecastHeatRisk

Aus der Prognose wird ein globaler Wert berechnet:

```text
forecastHeatRisk = 0 ... 100
```

Berücksichtigt werden:

1. maximale Temperatur innerhalb der nächsten 24 Stunden
2. Dauer höherer Temperaturen
3. thermische Gesamtbelastung
4. nächtliches Abkühlpotenzial

---

# 15. Heat-Degree-Hours

Die Dauer der Wärme wird als vereinfachte thermische Last berechnet.

Standard-Basistemperatur:

```text
heatLoadBaseTemperature = 22 °C
```

Pro 3-Stunden-Periode:

```text
heatLoad += max(0, forecastTemperature - 22) * 3
```

Beispiel:

3 Stunden mit 28 °C:

```text
(28 - 22) × 3 = 18 Degree-Hours
```

Dadurch wird ein ganzer warmer Tag stärker gewichtet als eine einzelne kurzzeitige Temperaturspitze.

---

# 16. Konfigurierbare Bewertungskurven

Alle Bewertungskennlinien werden konfigurierbar abgelegt.

Beispiel für maximale Prognosetemperatur:

```text
20 °C ->   0
25 °C ->  35
28 °C ->  60
31 °C ->  80
34 °C -> 100
```

Zwischenpunkte werden linear interpoliert.

Beispiel Heat-Load:

```text
0  Degree-Hours ->   0
24 Degree-Hours ->  30
48 Degree-Hours ->  55
72 Degree-Hours ->  75
96 Degree-Hours -> 100
```

Beispiel Nachtminimum:

```text
10 °C ->   0
15 °C ->  20
18 °C ->  50
20 °C ->  75
22 °C -> 100
```

Mehrere längere Perioden unter einer konfigurierbaren Abkühltemperatur reduzieren die Bewertung zusätzlich.

Standard:

```text
coolingTemperature = 16 °C
```

---

# 17. Forecast-Risk-Formel

Vorgeschlagene Standardgewichtung:

```text
forecastHeatRisk =
    maxTemperatureScore * 0.35
  + heatLoadScore       * 0.35
  + warmNightScore      * 0.30
```

Alle Gewichtungen sind konfigurierbar.

Ergebnis:

```text
0 ... 100
```

---

# 18. Raumtemperatur

Jedes Fenster wird einem Raumtemperatur-State zugeordnet.

Aus der Raumtemperatur wird ebenfalls ein Wert zwischen 0 und 100 berechnet.

Standardkennlinie:

```text
21 °C ->   0
23 °C ->  20
24 °C ->  40
25 °C ->  60
26 °C ->  75
28 °C -> 100
```

Pro Fenster kann ein Temperatur-Offset angegeben werden.

---

# 19. HeatRisk pro Fenster

Der endgültige Hitzewert wird pro Fenster berechnet:

```text
heatRisk =
    forecastHeatRisk * 0.70
  + roomTemperatureScore * 0.30
```

Standardgewichtung:

```text
70 % Wetterprognose
30 % aktuelle Raumtemperatur
```

Auch diese Gewichtung ist konfigurierbar.

---

# 20. Heat-Risk-Klassen

Standard:

```text
0–29   = niedrig
30–54  = mittel
55–74  = hoch
75–100 = sehr hoch
```

Die Grenzen sind konfigurierbar.

---

# 21. Sonnenexposition

Für jedes Fenster wird berechnet:

```text
solarExposure = 0 ... 100
```

Grundparameter:

- Sonnenazimut
- Sonnenhöhe
- Fensterazimut
- Bewölkung

---

# 22. Fensterazimut

Pro Fenster wird die Ausrichtung in Grad gespeichert.

Beispiel:

```text
Ost   = 90°
Süd   = 180°
West  = 270°
Nord  = 0°
```

Es wird nicht ausschließlich mit den Klassen Ost/Süd/West gearbeitet.

Die tatsächliche Winkeldifferenz zwischen Sonne und Fenster ist maßgeblich.

---

# 23. Optionaler Sonnenbereich

Pro Fenster können optional definiert werden:

```text
sunAzimuthMin
sunAzimuthMax
sunElevationMin
sunElevationMax
```

Damit können reale Verschattungen berücksichtigt werden, beispielsweise:

- Balkon
- Dachüberstand
- Nachbarhaus
- Baum
- Gebäudeecke

Ist ein Wert nicht gesetzt, erfolgt keine entsprechende Begrenzung.

---

# 24. Berechnung SolarExposure

Grundsätzlich:

```text
azimuthFactor =
    max(0, cos(sunAzimuth - windowAzimuth))
```

Zusätzlich wird ein Faktor für Sonnenhöhe berücksichtigt.

Die Bewölkung reduziert die wirksame Einstrahlung.

Vereinfachtes Modell:

```text
solarExposure =
    100
    × azimuthFactor
    × elevationFactor
    × cloudFactor
```

Das Ergebnis wird auf `0 ... 100` begrenzt.

---

# 25. Bewölkung

Bewölkung wird nicht als binäre Entscheidung verwendet.

Beispielsweise darf:

```text
clouds = 80 %
```

die Sonnenwirkung deutlich reduzieren, aber nicht automatisch auf null setzen.

Damit reagiert die Steuerung nicht auf jede einzelne Wolke mit einer Rollladenfahrt.

Die Stärke der Wolkenabschwächung ist konfigurierbar.

---

# 26. Vorausschauende Sonneneinstrahlung

Bei hoher Hitzebelastung darf der Adapter zusätzlich die erwartete Sonnensituation der kommenden Stunden berücksichtigen.

Ziel:

Ein Rollladen soll an einem sehr heißen Tag nicht vollständig geöffnet werden, wenn absehbar ist, dass kurz danach starke Sonne auf das Fenster trifft.

Für die nächsten Prognoseperioden werden verwendet:

- vorhergesagte Bewölkung
- berechnete zukünftige Sonnenposition
- Fensterazimut

Die zukünftige Sonnenposition darf anhand der ioBroker-Systemkoordinaten bzw. konfigurierter geografischer Koordinaten berechnet werden.

Bei niedriger oder mittlerer Hitzebelastung wird diese vorausschauende Verschattung nur schwach oder gar nicht angewendet, damit möglichst viel Tageslicht erhalten bleibt.

---

# 27. Rollladenstufen

Die möglichen Verschattungsstufen werden als konfigurierbares Array hinterlegt.

Beispiel:

```json
[
  {
    "name": "open",
    "minExposure": 0,
    "position": 100
  },
  {
    "name": "light",
    "minExposure": 25,
    "position": 75
  },
  {
    "name": "medium",
    "minExposure": 45,
    "position": 50
  },
  {
    "name": "strong",
    "minExposure": 65,
    "position": 25
  },
  {
    "name": "closed",
    "minExposure": 85,
    "position": 0
  }
]
```

Anzahl, Schwellenwerte und Positionen sind frei konfigurierbar.

---

# 28. Tageslichtschutz

Nicht jede Sonnenexposition darf automatisch zu vollständiger Verschattung führen.

Abhängig vom HeatRisk wird deshalb eine maximal zulässige Schließung definiert.

Standard:

```text
HeatRisk niedrig:
    mindestens 75 % offen

HeatRisk mittel:
    mindestens 50 % offen

HeatRisk hoch:
    mindestens 25 % offen

HeatRisk sehr hoch:
    0 % erlaubt
```

Beispiel:

Die Sonnenberechnung fordert:

```text
25 %
```

HeatRisk ist jedoch niedrig.

Dann wird die Zielposition begrenzt auf:

```text
75 %
```

Damit bleibt Tageslicht im Raum.

---

# 29. Sehr heiße Tage

Bei sehr hohem HeatRisk wird der Tageslichtschutz zunehmend aufgehoben.

Insbesondere Süd- und Südwestfenster dürfen vollständig geschlossen werden.

Standarddefinition für „Süd“:

```text
abs(windowAzimuth - 180°) <= 45°
```

Der Toleranzwinkel wird konfigurierbar.

Beispielbedingung:

```text
heatRisk >= 75
AND
southFacing = true
AND
solarExposure >= 60
```

Ergebnis:

```text
targetPosition = 0
```

---

# 30. Ost- und Westfenster

Auch Ost- und Westfenster werden auf sehr heißen Tagen präventiv verschattet.

Es gibt hierfür keine grundsätzliche Ausnahme.

Die konkrete Position ergibt sich aus:

- tatsächlicher Sonnenexposition
- HeatRisk
- Wetterprognose
- Raumtemperatur

Damit kann beispielsweise ein Westfenster an einem heißen Nachmittag genauso stark verschattet werden wie ein Südfenster.

---

# 31. Abendliche Lockerung

Wenn die Außentemperatur am Abend deutlich fällt, darf wieder mehr Sonnenlicht in die Räume gelangen.

Voraussetzungen sind beispielsweise:

- Sonnenstand weiterhin relevant
- Temperaturtrend fallend
- keine kritische Raumtemperatur
- kein Emergency-Zustand
- kein aktiver manueller Hold
- Mindestfahrzeit eingehalten

Standardparameter:

```text
eveningCoolingDelta = 2 °C
```

Beispiel:

Die Temperaturprognose fällt innerhalb der nächsten drei Stunden um mindestens 2 °C.

Dann darf der Rollladen eine Verschattungsstufe weiter geöffnet werden.

Beispiel:

```text
25 % -> 50 %
```

Nicht:

```text
25 % -> 100 %
```

Die Abendlockerung erfolgt somit bewusst schrittweise.

---

# 32. Manuelle Bedienung

Manuelle Änderungen haben Vorrang vor der normalen Automatik.

Standard:

```text
manualHoldMinutes = 60
```

Nach einem erkannten manuellen Eingriff bleibt die Position mindestens 60 Minuten unangetastet.

---

# 33. Erkennung manueller Änderungen

Der Adapter muss selbst erkennen, ob eine Bewegung von ihm ausgelöst wurde.

Bei jedem eigenen Fahrbefehl werden gespeichert:

```text
targetPosition
commandTimestamp
commandId
```

Zusätzlich gibt es ein Zeitfenster:

```text
selfActionRecognitionTimeout
```

Beispiel:

```text
120 Sekunden
```

Positionsänderungen, die plausibel zu diesem eigenen Fahrbefehl gehören, werden als automatische Bewegung klassifiziert.

Positionsänderungen, die:

- ohne eigenen ausstehenden Fahrbefehl auftreten,
- ein anderes Ziel haben,
- oder außerhalb des Erkennungszeitfensters erfolgen,

werden als manueller Eingriff behandelt.

---

# 34. Toleranz der manuellen Erkennung

Kleine Rückmeldungsabweichungen dürfen nicht als manueller Eingriff gelten.

Konfigurierbarer Parameter:

```text
manualDetectionTolerance
```

Beispiel:

```text
3 Prozentpunkte
```

---

# 35. Verlängerung des manuellen Holds

Nach Ablauf der Mindestzeit darf die Automatik nicht zwingend sofort übernehmen.

Ist die aktuelle Sonnenexposition gering:

```text
solarExposure < manualHoldLowExposureThreshold
```

wird der manuell eingestellte Zustand weiter respektiert.

Standard:

```text
manualHoldLowExposureThreshold = 20
```

Dadurch wird beispielsweise ein manuell eingestellter Rollladen nicht unnötig bewegt, wenn ohnehin kaum Sonnenenergie auf das Fenster fällt.

---

# 36. Verhalten nach manuellem Öffnen

Wurde ein Rollladen manuell weiter geöffnet:

- mindestens 60 Minuten keine automatische Änderung,
- danach nur wieder schließen, wenn der Hitzeschutz dies tatsächlich verlangt,
- bei geringer Sonnenexposition bleibt die manuelle Position bestehen.

---

# 37. Verhalten nach manuellem Schließen

Wurde ein Rollladen manuell weiter geschlossen:

- mindestens 60 Minuten keine automatische Änderung,
- bei geringer Sonnenexposition bleibt die Position darüber hinaus bestehen,
- erst bei einem nachvollziehbaren neuen Steuerungsbedarf darf die Automatik wieder übernehmen.

---

# 38. Emergency-Hitzeschutz

Es existiert optional eine Ausnahme von der normalen 60-Minuten-Sperre.

Standardparameter:

```text
emergencyEnabled = true
emergencyRoomTemperature = 28 °C
emergencyHeatRisk = 90
emergencyMinMovementInterval = 15 Minuten
```

Emergency darf ausschließlich eine stärkere Verschattung auslösen.

Er darf niemals zum vorzeitigen Öffnen führen.

Beispiel:

```text
Ist: 50 %
Emergency-Ziel: 0 %
```

Eine Bewegung darf nach 15 Minuten erfolgen.

---

# 39. Schutz manueller Bedienung im Emergency-Fall

Die Mindesthaltezeit eines manuellen Eingriffs wird auch im Emergency-Fall respektiert.

Das bedeutet:

Innerhalb der ersten:

```text
manualHoldMinutes
```

nach einer manuellen Änderung erfolgt keine automatische Korrektur.

Die explizite Anforderung „manuelle Position mindestens eine Stunde unverändert“ hat Vorrang.

---

# 40. Fenster- und Türkontakte

Pro Fenster kann optional ein Kontakt-State definiert werden.

Konfigurierbare Modi:

```text
ignore
blockClosing
forceOpenWhileOpen
```

## ignore

Kontakt wird nicht berücksichtigt.

## blockClosing

Standard.

Bei geöffnetem Kontakt darf der Rollladen nicht weiter geschlossen werden.

Automatisches Öffnen ist zulässig.

## forceOpenWhileOpen

Bei geöffnetem Kontakt wird der Rollladen auf eine konfigurierbare Sicherheitsposition geöffnet.

Dieser Modus ist insbesondere für Balkon- und Terrassentüren vorgesehen.

---

# 41. Morgendliches Öffnen

Pro Fenster:

```text
autoOpenMorning
morningOpenPosition
```

Beispiel:

Wohnzimmer:

```text
autoOpenMorning = true
```

Schlafzimmer:

```text
autoOpenMorning = false
```

Die Einstellung wird im normalen Modus respektiert.

---

# 42. Hitzeschutz beim morgendlichen Öffnen

Ein morgendliches Öffnen darf nicht blind auf 100 % erfolgen.

Beispiel:

```text
morningOpenPosition = 100
berechnete Hitzeschutzposition = 50
```

Dann gilt:

```text
targetPosition = 50
```

Dadurch wird vermieden:

1. morgens vollständig zu öffnen,
2. 20 Minuten später starke Sonne zu erkennen,
3. wegen der 60-Minuten-Sperre nicht wieder schließen zu dürfen.

---

# 43. Urlaubsmodus – morgens

Im Urlaubsmodus wird:

```text
autoOpenMorning
```

für alle aktivierten Fenster übersteuert.

Alle aktivierten Rollläden nehmen am automatischen morgendlichen Öffnen teil.

Auch hierbei wird die aktuelle Hitzeschutzposition berücksichtigt.

Ein heißer Tag kann daher beispielsweise dazu führen, dass ein Rollladen morgens nur auf 50 % statt 100 % geöffnet wird.

---

# 44. Urlaubsmodus – abends

Im Urlaubsmodus werden alle aktivierten Rollläden automatisch geschlossen.

Standardstrategie:

```text
sunset + vacationSunsetOffset
```

mit zusätzlicher spätester Schließzeit.

Parameter:

```text
vacationSunsetOffsetMinutes
vacationLatestCloseTime
```

Die Schließzeit ist:

```text
min(
    sunset + vacationSunsetOffset,
    vacationLatestCloseTime
)
```

Dadurch passt sich die Steuerung an die Jahreszeit an, kann aber im Sommer nicht unbegrenzt spät schließen.

---

# 45. Ermittlung Sonnenuntergang

Bevorzugt wird der Sonnenuntergang anhand geografischer Koordinaten berechnet.

Quelle:

- ioBroker-Systemkoordinaten

oder optional:

- im Adapter eingetragene Latitude/Longitude

Ein externer Sunset-State kann optional unterstützt werden.

---

# 46. Verhalten bei manueller Änderung im Urlaubsmodus

Auch im Urlaubsmodus gilt die manuelle Mindesthaltezeit.

Wird beispielsweise kurz vor dem automatischen Abendschließen manuell geöffnet, erfolgt kein sofortiges Gegenschließen.

Nach Ablauf der manuellen Sperre darf die ausstehende Urlaubsschließung nachgeholt werden.

---

# 47. Konfiguration pro Fenster

Jedes Fenster erhält einen stabilen internen Schlüssel.

Beispielkonfiguration:

```text
id
name
enabled

blindSetState
blindActualState

roomTemperatureState

contactState #optional
contactMode #optional

windowAzimuth

sunAzimuthMin #optional
sunAzimuthMax #optional
sunElevationMin #optional
sunElevationMax #optional

autoOpenMorning #optional
morningOpenPosition #optional

temperatureOffset #optional
heatProtectionOffset #optional
```

Optional können weitere Fensterparameter globale Einstellungen überschreiben.

---

# 48. Globale vs. individuelle Parameter

Grundprinzip:

Allgemeine Parameter werden global definiert.

Ein Fenster kann nur dort eigene Werte erhalten, wo dies sinnvoll ist.

Beispiele für globale Parameter:

- Rollladenstufen
- HeatRisk-Grenzen
- Mindestfahrzeit
- manuelle Sperrzeit
- Bewertungsintervall
- Tageslichtgrenzen

Beispiele für Fensterparameter:

- Azimut
- Temperatur-State
- Kontakt
- morgendliches Öffnen
- Verschattungsbereich
- Temperaturkorrektur

---

# 49. Diagnose-States global

Mindestens:

```text
info.active
info.lastEvaluation
info.forecastValid
info.forecastHeatRisk

info.forecastMaxTemperature24h
info.forecastMinTemperature24h
info.forecastHeatLoad24h

info.currentOutsideTemperature
info.currentCloudCover

info.nextVacationOpen
info.nextVacationClose
```

---

# 50. Diagnose-States pro Fenster

Beispielstruktur:

```text
windows.<id>.currentPosition
windows.<id>.roomTemperature

windows.<id>.solarExposure
windows.<id>.decisionSolarExposure
windows.<id>.heatRisk

windows.<id>.desiredPosition
windows.<id>.effectiveTargetPosition

windows.<id>.manualHoldActive
windows.<id>.manualHoldUntil

windows.<id>.lastManualAction
windows.<id>.lastAutoAction

windows.<id>.nextAutoMovementAllowed

windows.<id>.contactOpen

windows.<id>.blocked
windows.<id>.blockedReason
windows.<id>.decisionReason
```

---

# 51. BlockedReason

Der Adapter soll nachvollziehbar erklären, warum keine Bewegung erfolgt.

Definierte Werte beispielsweise:

```text
NONE
GLOBAL_DISABLED
PAUSED_TODAY
OUTSIDE_CONTROL_TIME
WINDOW_DISABLED
INVALID_FORECAST
INVALID_ROOM_TEMPERATURE
INVALID_SUN_POSITION
CONTACT_OPEN
MANUAL_HOLD
MIN_MOVEMENT_INTERVAL
POSITION_CHANGE_TOO_SMALL
NO_RELEVANT_SOLAR_EXPOSURE
EARLIEST_OPEN_NOT_REACHED
```

---

# 52. DecisionReason

Bei einer Bewegung soll ebenfalls nachvollziehbar sein, warum sie erfolgt.

Beispiele:

```text
MORNING_OPEN
VACATION_MORNING_OPEN
VACATION_EVENING_CLOSE

SUN_PROTECTION
HIGH_HEAT_PROTECTION
EXTREME_HEAT_PROTECTION

EMERGENCY_HEAT_PROTECTION
EVENING_RELAXATION
```

---

# 53. Hysterese

Damit Grenzwerte nicht zu ständig wechselnden Zielpositionen führen, wird eine Hysterese verwendet.

Beispiel:

```text
solarExposureHysteresis = 5
heatRiskHysteresis = 5
```

Eine bereits aktive Stufe wird also nicht unmittelbar verlassen, nur weil ein Messwert minimal über oder unter einem Grenzwert liegt.

---

# 54. Fehlerverhalten

Grundsatz:

## Fail safe = keine Bewegung

Fehlen notwendige Daten oder sind diese ungültig, verändert der Adapter die Rollladenposition nicht.

Das betrifft insbesondere:

- Sonnenposition
- Raumtemperatur
- Wetterprognose
- Rollladenposition

Es erfolgt:

- Diagnose-State
- Logeintrag
- keine automatische Bewegung

---

# 55. Datenalter

Für unterschiedliche Datenarten werden konfigurierbare maximale Datenalter vorgesehen.

Beispielsweise:

```text
sunPositionMaxAge
weatherCurrentMaxAge
forecastMaxAge
roomTemperatureMaxAge
```

Die Standardwerte sind so zu wählen, dass Sensoren, die nur bei Wertänderung senden, nicht unnötig als fehlerhaft gelten.

---

# 56. Verhalten beim Adapterstart

Nach einem Neustart darf der Adapter nicht sofort unkontrolliert Rollläden bewegen.

Vorgehen:

1. Konfiguration laden
2. persistierte Aktionszeiten laden
3. States abonnieren
4. Eingangsdaten validieren
5. Startup-Verzögerung abwarten
6. Situation vollständig berechnen
7. vorhandene Sperrzeiten respektieren
8. erst danach gegebenenfalls fahren

Konfigurierbar:

```text
startupDelaySeconds
```

Beispiel:

```text
30 Sekunden
```

---

# 57. Persistenz

Mindestens folgende Informationen müssen Neustarts überstehen:

- Zeitpunkt letzter automatischer Bewegung pro Fenster
- Zeitpunkt letzter manueller Bewegung
- manuelle Hold-Information
- letzter erkannter Auto-Target
- letzter Heat-Risk-Bereich für Hysterese
- Datum von `pauseToday`
- Urlaubsstatus
- global enabled

Ein Adapterneustart darf die 60-Minuten-Sperre nicht zurücksetzen.

---

# 58. Admin-Oberfläche

Vorgesehene Tabs:

## Allgemein

- enabled
- Aktivzeit
- earliestAutoOpen
- Bewertungsintervall
- Mindestfahrzeit
- Mindestpositionsänderung

## Wetter

- Wetterprovider
- OpenWeatherMap-Instanz
- aktuelle Außentemperatur
- aktuelle Bewölkung
- Forecast-Mapping
- 24h-HeatRisk-Kennlinien

## Sonne

- Sonnenquelle
- Latitude/Longitude
- Bewölkungsgewichtung
- Expositionsparameter

## Verschattung

- konfigurierbares Rollladenstufen-Array
- HeatRisk-Klassen
- Tageslichtgrenzen
- Süd-Fenster-Regel
- Abendlockerung

## Manuelle Bedienung

- Hold-Dauer
- Expositionsgrenze zur Verlängerung
- Erkennungstoleranz
- Auto-Command-Timeout

## Emergency

- Aktivierung
- Raumtemperaturschwelle
- HeatRisk-Schwelle
- Mindestfahrzeit

## Urlaub

- Sunset-Offset
- späteste Schließzeit
- Öffnungsparameter

## Fenster

Konfigurierbare Tabelle aller Fenster.

---

# 59. Ereignisverarbeitung

State-Änderungen werden nicht direkt in Fahrbefehle übersetzt.

Stattdessen:

```text
State change
    ↓
interne Daten aktualisieren
    ↓
Neubewertung anfordern
    ↓
Decision Engine
    ↓
Sperren prüfen
    ↓
ggf. Fahrbefehl
```

Mehrere nahezu gleichzeitig eintreffende State-Änderungen werden zusammengefasst.

Damit führt beispielsweise die gleichzeitige Aktualisierung mehrerer OpenWeatherMap-States nicht zu mehrfachen Entscheidungen.

---

# 60. Grundalgorithmus pro Fenster

Pseudocode:

```text
if global disabled:
    stop

if pauseToday:
    stop

validate inputs

calculate forecastHeatRisk
calculate roomTemperatureScore
calculate heatRisk

calculate currentSolarExposure
calculate futureSolarExposure
calculate decisionSolarExposure

calculate shadeLevel from decisionSolarExposure

limit shadeLevel according to heatRisk/daylight rules

apply extreme-heat rules

apply evening relaxation

calculate desiredPosition

apply morning/vacation rules

check contact

check manual hold

check minimum movement interval

check emergency exception

check minimum position difference

send target position
```

---

# 61. Besonderheit: Öffnen und Schließen

Das System behandelt Öffnen und Schließen bewusst unterschiedlich.

## Schließen

Bei zunehmender Hitze darf direkt eine deutlich stärkere Verschattungsstufe gewählt werden.

Beispiel:

```text
75 % -> 25 %
```

ist zulässig.

## Öffnen

Insbesondere bei der Abendlockerung soll vorsichtiger geöffnet werden.

Standard:

```text
maximal eine Verschattungsstufe pro Abendlockerungsaktion
```

---

# 62. Beispiel – kühler Herbsttag

Prognose:

```text
Maximum 25 °C
Minimum 10 °C
```

Raum:

```text
22 °C
```

Ergebnis:

- relativ niedriger ForecastHeatRisk
- gutes nächtliches Abkühlpotenzial
- Tageslicht hat hohe Priorität
- selbst bei direkter Sonne nur leichte bis mittlere Verschattung

Ein vollständiges Schließen ist nicht vorgesehen.

---

# 63. Beispiel – warmer Sommertag

Prognose:

```text
Maximum 25 °C
Minimum 20 °C
```

Raum:

```text
24 °C
```

Obwohl das Tagesmaximum identisch mit dem Herbstbeispiel ist:

- höhere Heat-Load
- warme Nacht
- geringes Abkühlpotenzial
- höhere Raumtemperatur

Ergebnis:

deutlich stärkere Verschattung.

---

# 64. Beispiel – sehr heißer Sommertag

Prognose:

```text
Maximum 33 °C
Minimum 22 °C
```

Südfenster mit hoher direkter Sonneneinstrahlung.

Ergebnis:

```text
targetPosition = 0 %
```

sofern keine höher priorisierte Sperre besteht.

---

# 65. Beispiel – manueller Eingriff

Automatik steht auf:

```text
50 %
```

Benutzer öffnet manuell auf:

```text
100 %
```

Folge:

```text
manualHold = 60 Minuten
```

Währenddessen keine automatische Korrektur.

Nach 60 Minuten:

### starke Sonne + hoher HeatRisk

Automatik darf wieder verschatten.

### geringe Sonnenexposition

Manuelle Position bleibt weiterhin bestehen.

---

# 66. Beispiel – Wolke

Rollladen steht bei:

```text
50 %
```

Eine Wolke reduziert SolarExposure kurzzeitig.

Aufgrund von:

- 60-Minuten-Regel
- Hysterese
- Mindestpositionsänderung
- Forecast-Betrachtung

wird nicht sofort geöffnet.

Die Wolke verschwindet wieder, ohne dass eine unnötige Rollladenfahrt erfolgt.

---

# 67. Beispiel – Abend

Nach einem heißen Nachmittag:

```text
Rollladen = 25 %
```

Außentemperatur fällt deutlich.

Raumtemperatur ist nicht kritisch.

Noch vorhandene Abendsonne ist erwünscht.

Ergebnis:

```text
25 % -> 50 %
```

Nach frühestens einer weiteren Stunde könnte erneut weiter geöffnet werden, falls die Bedingungen weiterhin passen.

---

# 68. Beispiel – geöffnete Terrassentür

Kontakt:

```text
open
```

Modus:

```text
blockClosing
```

Berechneter Hitzeschutz:

```text
0 %
```

Aktuell:

```text
100 %
```

Ergebnis:

keine Bewegung.

Diagnose:

```text
blockedReason = CONTACT_OPEN
```

---

# 69. Beispiel – Urlaub

Morgens:

- früheste Öffnungszeit erreicht
- alle aktivierten Fenster werden berücksichtigt
- bei starkem Hitzeschutz wird nicht zwingend vollständig geöffnet

Tagsüber:

- normale HeatRisk-/Sonnenlogik

Abends:

```text
sunset + offset
```

bzw. spätestens:

```text
vacationLatestCloseTime
```

→ Rollläden schließen.

---

# 70. Akzeptanzkriterien

Die Implementierung gilt fachlich als erfolgreich, wenn mindestens folgende Tests erfüllt sind:

1. Kein Fenster fährt bei `enabled=false`.
2. Kein Fenster fährt bei `pauseToday=true`.
3. `pauseToday` wird am folgenden Kalendertag zurückgesetzt.
4. Ein automatischer Rollladen fährt normalerweise höchstens einmal pro Stunde.
5. Die Sperrzeit überlebt einen Adapterneustart.
6. Ein manueller Eingriff wird erkannt.
7. Ein manueller Eingriff wird mindestens 60 Minuten respektiert.
8. Bei niedriger Sonnenexposition wird der manuelle Hold verlängert.
9. Ein Emergency darf ausschließlich stärker schließen.
10. Emergency hebt die erste Stunde eines manuellen Holds nicht auf.
11. Geöffnete Türen verhindern bei `blockClosing` weiteres Schließen.
12. Sehr heiße Prognosen führen zu stärkerem Hitzeschutz.
13. Eine warme Nacht erhöht den HeatRisk.
14. Eine kühle Nacht reduziert den HeatRisk deutlich.
15. Südseiten dürfen bei sehr hoher Hitzebelastung vollständig geschlossen werden.
16. Bei moderatem Wetter bleibt Tageslicht erhalten.
17. Kurzfristige Bewölkungsänderungen verursachen kein Hin-und-Her-Fahren.
18. Abendliche Abkühlung kann eine stufenweise Öffnung auslösen.
19. Im Normalmodus wird `autoOpenMorning=false` respektiert.
20. Im Urlaubsmodus werden alle aktivierten Fenster morgens berücksichtigt.
21. Im Urlaubsmodus werden alle aktivierten Fenster abends geschlossen.
22. Ungültige oder fehlende Eingangsdaten führen zu keiner Bewegung.
23. Jede blockierte Bewegung hat einen nachvollziehbaren `blockedReason`.
24. Jede ausgeführte Bewegung hat einen nachvollziehbaren `decisionReason`.
25. Im Dry-Run-Modus wird niemals ein realer Rollladenbefehl gesendet.

---

# 71. Leitprinzip der Steuerung

Die Steuerung soll sich im Alltag nach folgendem Grundsatz verhalten:

> So offen wie möglich, so geschlossen wie thermisch nötig – und so selten bewegen wie möglich.

Die Wetterprognose sorgt für vorausschauendes Handeln, die aktuelle Raumtemperatur für Rückkopplung, der Sonnenstand für die fensterspezifische Entscheidung und die Sperrlogik dafür, dass die Automatik für die Bewohner nicht störend wird.