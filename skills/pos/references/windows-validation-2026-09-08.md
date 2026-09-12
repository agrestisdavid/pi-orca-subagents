# Pi Bots – Windows-Prüfung vom 8. September 2026

Umgebung: Windows, Node.js 24.14.0, Pi 0.85.1, pi-subagents 0.65.1,
Orca 1.4.196. Testprojekt: `<previous Pi workspace>/tests/pi-bots-orca`.

## Ergebnis

Der dateibasierte Chat-Viewer und die echte Orca-Dispatch-Anbindung sind
implementiert. Die Runtime hat Shell-Dispatch, Fragen, Antworten und
`worker_done` aus den jeweils zugewiesenen Adapter-Terminals bestätigt.
Die native Ende-zu-Ende-Abnahme bleibt durch die vorhandene Pi-Installation
blockiert; die erfolgreichen Workflow-Integrationstests verwenden simulierte
native RPC-Receipts/Statusdateien und eine echte Orca-Runtime.

Rollenprofile, Modellzuordnungen, native workflowScript-Ausführung, FleetView
und Prozesssteuerung werden weiterhin von pi-subagents übernommen. An deren
Implementierung oder Einstellungen wurde nichts geändert. Die nativen
Steer-/Interrupt-/Stop-Parameter sind zusätzlich im RPC-Test geprüft.

## Nativer Fortschritts-Tab

Orca wurde gestartet, das isolierte Git-Testverzeichnis über `orca repo add`
registriert und genau ein nativer asynchroner Scout-Start versucht. Die
Pi-Bots-Extension war in diesem Host nicht geladen. Der Test setzte temporär
`extensions/subagent/config.json` auf `orcaProgressTabs.enabled: true`.

Der native Start brach vor dem Start des Kindes mit folgender konkreter
Abhängigkeitsprüfung ab:

```text
Background children require pi installed as the npm package
(@earendil-works/pi-coding-agent) with its dependencies;
<user application data>\npm\node_modules\@earendil-works\pi-coding-agent
does not provide @earendil-works/pi-server, @earendil-works/pi-server/unix,
@earendil-works/pi-client/unix, so the async runner cannot create child sessions.
```

Ergebnis: kein erfolgreicher Scout-Lauf, kein gestartetes KI-Kind und kein neuer
Tab (vorher 2, nachher 2, keine neuen Handles). Dies beweist allein noch nicht
die Wirkung der Windows-Sperre, da der Start bereits vorher scheiterte.
Der installierte Quelltext enthält unabhängig davon in
`src/runs/shared/orca-progress-tabs.ts:329` den expliziten Ausschluss
`process.platform === "win32"`. Dieser wurde nicht verändert.

Der ursprüngliche Konfigurationszustand wurde wiederhergestellt: Die vorher
nicht vorhandene `config.json` fehlt wieder. `orcaProgressTabs` ist dadurch
nicht dauerhaft aktiviert. Die native Funktion enthält auch keine
Orca-Dispatch-Anbindung und ersetzt keinen vollständigen Session-Viewer.

Belege: `tests/pi-bots-orca/native-smoke.json`, `native-host.log` und
`native-progress-test.json`.

## Durchgeführte Prüfungen

| Prüfung | Ergebnis und Grenze |
|---|---|
| `Test-PiBots.ps1` unter Windows PowerShell 5.1 | Bestanden: exakte IDs, sichere Argumentübergabe, gleiches Viewer-Programm in Herdr/Orca, konkurrierende Publisher/Cleanup, späte Oberflächen, Wiederverwendung, Rollback und fehlgeschlagene Abfragen. App-CLIs in dieser Suite simuliert. |
| `Test-PiBotsExtension.mjs` | Bestanden: native RPC-Parameter, Start/Resume, Abbruch, falsche/verspätete Receipt, gesperrter Ersatzstart, Reload und ursprüngliche Request-ID, Supervisor-Scope. Nativer RPC simuliert. |
| `Test-ChatViewer.mjs` | Bestanden: über 900 KB, 1.500 Nachrichten, 600-KB-Tool-Ergebnis, erste und letzte Inhalte, Fork-Kontext, Supervisor-Inhalt, neue Records bei festem Scrollanker, unvollständige JSONL-Zeile, Fallback, Terminal-Sanitizing. |
| `Test-AdapterRecovery.mjs` | Bestanden: genau ein Aufruf, wiederverwendete Receipt, Crash ohne Receipt bleibt gesperrt, `request-show` vor Recovery mit ursprünglicher ID, kein Retry bei `absent`, veraltete Heartbeats und Orca-Ausfall beeinflussen keinen nativen Status. |
| `Test-OrcaDispatch.mjs` | Echte Orca-Runtime: eigener Koordinator und Worker ohne Modell, Shell-Dispatch mit Preamble, zugeordnete Frage/Antwort, akzeptiertes `worker_done`, Task und Dispatch abgeschlossen. |
| `Test-OrcaBridge.mjs` | Echte Orca-Runtime, native Daten simuliert: Erfolg, Fehler und Stop mit explizitem Outcome; jeweils ein Task/Dispatch. Native Fragen und bestätigte Antworten korrelieren anhand der Request-ID. |
| `Test-OrcaBridge.mjs bridge-final complete` | Echte Runtime: sofortiger nativer Abschluss nach Antwort; `worker_done` wartet auf die Orca-Antwortbestätigung. |
| `Test-PiBotsOrca.mjs` | Extension mit echter Orca-Runtime: Dispatch vor genau einem nativen RPC-Aufruf; Abbruch verhindert Ersatzstart; späte native Receipt stellt Zuordnung her; Adapter meldet Abschluss nach Parent-Shutdown. Nativer Start simuliert. |
| `Test-OrcaChat.mjs` | Echter Orca-Tab: Home erreicht Originalauftrag jenseits von 256 KB; neue Nachricht lässt zurückgeblätterte Seite stehen; Follow zeigt neue Nachricht; exakter Cleanup. Chatdaten simuliert. |
| `Test-DynamicViews.mjs` | Extension und echte Orca-Tabs: zwei parallele Kinder, später drittes Kind, wiederholtes `sync_views`; genau drei unterschiedliche Views, keine doppelten Tabs. Native Run-Daten simuliert. |
| Tatsächlicher Pi-Host | Extension isoliert geladen; `get_state` erfolgreich, keine Loader-Fehler, kein Modellaufruf. |

Alle während dieser Prüfungen erzeugten Orca-Terminals wurden anhand ihrer
gespeicherten IDs geschlossen. Im Testprojekt verbleiben Logs und Belege.
Der eigenständige, veraltete Herdr-Start-Skill bleibt entfernt; aktive Skills, Agenten
und Extensions enthalten keine Verweise auf den alten Startweg.

## Echte Dispatch-Belege

Der erste Prototyp wurde in Orca als `worker_report` abgeschlossen:

- Run: `run_139338e0f829`
- Task: `task_56d1426983e9`
- Dispatch: `ctx_5b51bd8e26e3`
- zugewiesener Worker: `term_4c2ab931-9a79-44e3-8884-88099c92bf8b`
- Frage: `msg_9ca50a428023`
- Abschluss: `msg_7ec6edc71171`, Outcome `succeeded`

Vollständige Belege: `tests/pi-bots-orca/dispatch-smoke.json`,
`bridge-integration/results.json`, `bridge-final/results.json`,
`extension-integration-*/test-result.json`, `dynamic-*/test-result.json` und
`chat-ui/ui-test-result.json`. Diese Dateien unterscheiden Testdaten ausdrücklich
von echten Runtime-Receipts.

## Verbleibende Grenzen

1. **Native Live-Abnahme:** Die fehlenden Host-Pakete/Exports der installierten
   Pi-Version müssen repariert oder durch eine kompatible Paketkombination
   ersetzt werden. Dieser Umbau verändert keine Dateien in `node_modules` und
   installiert/aktualisiert keine globalen Pakete. Ein erfolgreiches echtes
   Scout-/workflowScript-Ergebnis ist daher noch nicht nachgewiesen.
2. **Kompletter Verlust der nativen Receipt:** pi-subagents 0.65.1 bietet für
   Spawn/Resume keinen dauerhaften Request-Lookup. Nach Verlust des gesamten
   Hosts ohne Receipt bleibt die Originalanfrage gespeichert und gesperrt.
   Ein neuer Lauf darf daraus nicht als vermeintliche Wiederherstellung entstehen.
3. **Verlust der Adapteridentität:** Die Adapter-Outbox überlebt Reloads und
   Verbindungsfehler. Fehlt die ursprüngliche Orca-Request-ID nach einem Crash
   zwischen CLI-Aufruf und Receipt, oder wurde das zugewiesene Terminal
   geschlossen, wird keine neue Identität geraten. Die Zuordnung verlangt dann
   manuelle, belegte Wiederherstellung. `request-show: absent` gilt nicht als
   Erlaubnis für einen neuen Dispatch.
4. **Verfügbarer Chat:** Der Viewer zeigt Originalrecords ohne eigene
   Größenbegrenzung. Er kann bereits gelöschte, gekürzte oder redigierte
   Quelldaten nicht zurückholen. Bilder/Audio werden als Anhänge ausgewiesen;
   ihre Binärdaten werden im Terminal nicht dargestellt.

Eine reine Fortschrittsanzeige wurde nicht als Dispatch-Integration gewertet.
Die Orca-Seite ist durch echte Runtime-Receipts belegt; die native Live-Abnahme
bleibt ausdrücklich offen.
