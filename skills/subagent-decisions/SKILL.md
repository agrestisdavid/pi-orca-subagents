---
name: subagent-decisions
description: Use when delegating work through pi-subagents or workflowScript, including pi-bots runs, if a child may need a decision or clarification, or when a contact_supervisor request reaches the parent. Defines structured child questions, bounded-council escalation for real trade-offs, orchestrator-versus-user escalation, replies, and decision logging. Do not use for trivial one-shot children without decision risk.
---

# Subagent-Entscheidungen

Nutze dieses Protokoll für native `pi-subagents`-Kinder. Es gilt auch, wenn
`pi-bots` echte Orca-Pi-TUIs (`execution: "orca-tui"`) oder optionale
Dateiansichten ergänzt. Die Pi-TUI steuert dieselbe native Kind-Session;
Herdr und die älteren Headless-Viewer bleiben Leseansichten.

Bei `pi_bots(coordination: "orca")` erhält der gesamte native Workflow einen
Orca-Dispatch. Der Adapter spiegelt Fragen mit ihrer nativen Request-ID und
bestätigte Antworten des nativen `subagent_supervisor`. Behandle diese als
dieselbe Anfrage; antworte genau einmal über `subagent_supervisor`, den
kanonisch angebundenen Pi-Bots-Reply oder `/bot-reply` im verwalteten Kind-Tab.
Alle Wege verwenden dieselbe native Antwortfunktion und Request-ID. Nur die
erste bestätigte Antwort zählt; ein wartender UI-Auftrag ist keine Bestätigung.
Eine direkte Orca-Antwort löst keine native Supervisor-Anfrage auf.

Ändere keine `intercomBridge`-Konfiguration. Native `pi-subagents` stellen dem Kind
`contact_supervisor` und dem Parent `subagent_supervisor` bereit.

## Kindvertrag ergänzen

Hänge den folgenden englischen Vertrag an den Task-Text von `runs.run` oder
`subagent`, wenn das Kind auf eine wesentliche Mehrdeutigkeit treffen könnte:

```text
Decision protocol:
- Decide routine, reversible technical details that are within this task's delegated scope.
- If you are blocked on a decision, need clarification instead of guessing, or need a product, API, scope, or approval choice before continuing safely, contact the parent through contact_supervisor.
- Do not ask about review-only/no-project-edit versus progress or output-artifact instructions: no-project-edit wins, while normal findings and configured output artifacts remain allowed.
- Do not use the supervisor channel for routine completion handoffs.
- Use reason "need_decision" for one or more blocking choices, "interview_request" for structured multi-part input, and "progress_update" only for a meaningful non-blocking discovery that changes the plan.
- For need_decision and interview_request, stay alive and wait for the parent's reply before continuing.
- Consolidate related uncertainties. Ask no more than three decision questions during this run; one complete request is better than fragmented follow-ups.

For each blocking question, use this message format:
[DECISION NEEDED]
Context: <1-3 sentences explaining the finding and what is blocked>
Options:
  A) <option> — <consequence>
  B) <option> — <consequence>
Recommendation: <A or B> — <one-line rationale>
Safe default if unanswered: <conservative default, only when genuinely safe> (optional)
```

Die Zeile `Safe default if unanswered` ist nur ein Hinweis. Sie ermächtigt den
Parent nicht, stellvertretend für den Nutzer zu antworten.

## Supervisor-Anfragen bearbeiten

Prüfe bei einer Attention-Notice, während jedes relevanten Statuszyklus und vor
dem Start eines abhängigen Workflow-Schritts die nativen offenen Anfragen:

```typescript
subagent_supervisor({ action: "pending" })
```

Behandle jedes `replyTo` als exakte Routing-Identität. Leite das Ziel niemals aus
einem Kindernamen oder sichtbaren Spectator-Tab ab.

### Ohne Nutzerunterbrechung entscheiden

Der Orchestrator entscheidet selbst und antwortet direkt, wenn die Wahl alle
folgenden Bedingungen erfüllt:

- Sie ist ein technisches Implementierungsdetail innerhalb des delegierten
  Scopes.
- Sie ist reversibel und mit geringem Aufwand änderbar.
- Sie entspricht früheren Nutzerentscheidungen und akzeptierten Constraints.
- Sie ist nicht sicherheitsrelevant.

Dazu zählen Format-, Tool- und lokale Namenswahl, fokussierter Testumfang und
begrenzte Refactoring-Details. Hat der Nutzer den Punkt früher bereits
entschieden, antworte aus diesem Kontext und protokolliere als Quelle
`Orchestrator (via previous user decision)`.

### Bounded Council bei echtem Trade-off

Erkennt der Orchestrator bei einer zu eskalierenden Wahl einen *technischen*
Trade-off, den Advisor-Evidenz klären kann — Architektur oder API-Richtung,
irreversible oder teure Aktion, widersprüchliche Empfehlungen verschiedener
Kinder, Änderung einer bereits genehmigten Entscheidung —, so hält er **vor**
der Nutzerfrage einen bounded Council nach dem `council-mode`-Skill:

- Roster: `council-architect` + `council-risk`; zusätzlich `council-ops` nur
  bei Kosten-, Migrations- oder Komplexitätsfragen (max. 3, read-only).
- Pass-Cap 2 (unabhängige Reports, eine Cross-Examination); Pass 3 nur auf
  expliziten Nutzerwunsch.
- Das blockierende Kind bleibt alive/paused, bis die Antwort gesendet ist.
- Ergebnis: Parent-Memo mit Empfehlung, cross-examinierten Alternativen,
  Owner-Entscheidungen, Evidenz und Konfidenz.

Danach eskaliert der Orchestrator wie unten — aber das `ask_user_question`
trägt den Memo-Kontext, und die Council-Empfehlung steht an erster Stelle
(als `(Recommended)`, wenn sie der Orchestrator-Einschätzung entspricht).

**Kein Council:** rein produktseitige Scope-Fragen ohne technischen Trade-off
(beantwortet nur der Nutzer) sowie Zeitkritik (Kind blockiert, Frage ist
einfach darstellbar). Bei Sicherheit, Datenschutz, Zugangsdaten und
destruktiven Aktionen darf der Council die Analyse vorbereiten — die
Entscheidung geht immer an den Nutzer.

### Prinzipienentscheidungen eskalieren

Frage den Nutzer mit `ask_user_question`, wenn eine Wahl einen dieser Punkte
betrifft:

- Produktabsicht oder Scope-Grenze;
- Architektur oder Richtung einer öffentlichen API;
- irreversible oder teure/ressourcenintensive Aktion;
- Sicherheit, Datenschutz, Zugangsdaten, Berechtigungen oder destruktives
  Verhalten;
- widersprüchliche Evidenz oder Empfehlungen verschiedener Kinder; oder
- Änderung einer bereits vom Nutzer genehmigten Entscheidung.

Übernimm Optionen und Konsequenzen des Kindes. Hat der Orchestrator eine
Präferenz, setze sie an die erste Stelle und ergänze `(Recommended)` am Label.
Stelle exakt eine Frage pro Entscheidung. Fragen mehrere Kinder gleichzeitig,
bündele bis zu vier Fragen in einem `ask_user_question`-Aufruf. Bleiben weitere
übrig, löse und übermittle zuerst diesen Batch; staple keine Fragebögen direkt
hintereinander.

Nur die explizite Auswahl einer angebotenen Option zählt als Entscheidung.
Freitext, Abbruch/Esc, fehlende UI oder ein Toolfehler gelten in diesem
Protokoll als keine Entscheidung. Halte die Anfrage offen, statt daraus eine
Antwort abzuleiten.

### Dem exakten Kind antworten

Sende nach einer Orchestrator- oder Nutzerentscheidung eine knappe Antwort mit
Entscheidung und einzeiliger Begründung:

```typescript
subagent_supervisor({
  action: "reply",
  replyTo: "<request-id>",
  message: "Decision: <chosen option>. Rationale: <one sentence>. Continue within the original scope."
})
```

Sende für jedes `replyTo` genau ein `reply`, auch wenn Nutzerfragen gebündelt
waren. Ein `progress_update` ist nicht blockierend: Notiere und verdichte es
optional in einer Statuszeile, aber eskaliere es niemals allein.

## Pausen bei fehlender Antwort erhalten

Erhält eine eskalierte Frage keine gültige Nutzerauswahl, antworte weder mit dem
vorgeschlagenen Safe Default noch lasse das Kind raten. Lasse Kind und Workflow
`paused`, melde die offene Entscheidung bei der nächsten Nutzerinteraktion und
führe sie im Run-Fazit als ungelöst auf. Eine Safe-Default-Antwort ist erst
zulässig, nachdem der Nutzer dieses Verhalten in einer späteren Anweisung
explizit freigegeben hat.

Scheint eine Anfrage übersehen worden zu sein, prüfe in jedem folgenden
Statuszyklus erneut `pending`. Erscheinen Supervisor-Nachrichten nicht oder
schlägt eine Antwort fehl, führe Folgendes aus:

```typescript
subagent({ action: "doctor" })
```

Das entsprechende Slash-Kommando ist `/subagents-doctor`.

## Mit sichtbaren Ansichten arbeiten

Behandle bei einem `pi-bots`-Run den Status `paused` zusammen mit einer
Attention-Notice als möglichen aktionsfähigen Entscheidungs-Wait. Bestätige
ihn über `subagent_supervisor({ action: "pending" })`; Lifecycle- und
Pending-Request-Daten sind autoritativ, nicht das Aussehen eines Terminals.

Herdr und Headless-Viewer bleiben reine Leseansichten. In einer verwalteten
Orca-Pi-TUI sind Nachrichten, Escape und `/bot-reply <Antwort>` möglich.
Nach Abschluss führt `/bot-resume <Auftrag>` durch den nativen Resume-Weg.
`status`, `steer`, Stop und `subagent_supervisor` bleiben auch im Parent verfügbar.

## Entscheidungen protokollieren

Nenne im abschließenden Run-Fazit jede blockierende Kind-Anfrage, einschließlich
ungelöster Anfragen. Verwende diese kompakte Struktur:

```text
Decisions:
- Child: <stable child key>
  Question: <shortened question>
  Decision: <choice or unresolved>
  Decided by: Orchestrator | User | Orchestrator (via previous user decision) | —
  Rationale: <one line>
```

Wurde ein Council vor der Entscheidung gehalten, verweise im Rationale auf
die Council-Memo-Run-IDs.

Wesentliche `progress_update`-Highlights dürfen als eine verdichtete Zeile
folgen. Mache aus routinemäßigem Fortschritt keine Einträge im Entscheidungslog.
