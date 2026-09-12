# Native Pi TUI validation — Windows, 2026-09-09

Implementation: `agent/local-packages/pi-subagents`, version
`0.66.0-pi-bots.1`, based on upstream `0.66.0`. Pi SDK `0.85.1`, Node `24.14.0`,
Orca `1.4.196`, rpiv-todo `2.9.0`, node-pty `1.1.0`.

The subsequent `0.66.0-pi-bots.2` shared dispatch-pane option has a separate
[acceptance report](shared-dispatch-validation-2026-09-09.md), including its
different pane-close behavior. The detach/reattach results below describe
the original separate-child layout.

Evidence below is under `<previous Pi workspace>\tests\pi-bots-orca\`.
Reports preserve actual native IDs and command receipts. Old failed development
tests are retained; the passing reports named here supersede those attempts.

| Requirement | Evidence / result |
|---|---|
| Actual Pi TUI, official Pi recognition, real todo and direct chat | `lifecycle-1788929702467/result.json`: passed |
| Tab close/reopen, same Pi PID/session, parent reload | Same lifecycle report: passed |
| Canonical child-tab supervisor answer | Same lifecycle report: passed |
| Native resume, same session, previous writer exits first, new dispatch | `resume-1788926117405/result.json`: passed |
| Aborted resume / lost response, no duplicate model prompt | `lost-resume-1788929116557/result.json`: passed |
| Lost spawn reply, parent restart, dropped local control socket | `lost-reply-1788927464093/result.json`: passed |
| Parallel and dynamic children in one native workflow | `workflow-1788927541828/result.json`: passed; three distinct Pi sessions, one dispatch |
| Escape, session-switch guard, supervisor attention, stop and failure delivery | `controls-1788927713028/result.json`: passed |
| Transport outage while native execution continues | Same controls report: passed using an owned transport fault |
| Long native TUI history and navigation | `long-history-1788929631998/result.json`: passed; 801 synthetic messages, >256 KB, zero model prompts |
| Orca Agent Dashboard and unread completion badges | `dashboard-accessibility.txt`: actual Orca UI tree lists the tested Pi scouts with Done/unread completion |
| Legacy Herdr file viewer | `Test-ChatViewer.mjs`: paged long history, inherited context, fallback and display sanitization |
| Capability ceilings, request receipts, session ownership | Maintained fork `npm test` |
| Adapter outbox unknown/retry behavior | `Test-AdapterRecovery.mjs` |
| Durable adapter process restart in original panes | `adapter-restart-1788930574508/result.json`: passed; acknowledged restoration, original task and dispatch complete |
| Whole Orca desktop exit and restart into a new runtime | `orca-desktop-restart-1788931134462/result.json`: passed; same Pi/PTY/session, original question and dispatch complete, no duplicate start |
| Actual desktop outage detected while Pi continues | Same test directory, `desktop-outage.json`: disconnected health, original Pi process alive |
| Wrapper cancellation, late replies, resume and supervisor scope | `Test-PiBotsExtension.mjs` |
| Normal Pi installation / extension discovery | `installed-1788930332279/installed.json`: backend v1, native tools, Pi Bots and todo registered once |

The lifecycle tests use actual native scouts with configured Terra/medium,
native status, exact session JSONL, terminal identity, task-list and
dispatch-show evidence. The synthetic history test uses the same backend and
Pi InteractiveMode to test rendering only; it is not presented as AI work.

Native question arrival before answering and workflow success/failure receipt
were checked. Orca's real dashboard showed Pi agents and completion badges.
Windows toast presentation, sound and the user's notification preferences were
not changed or claimed as tested. Desktop screenshots from this multi-monitor
setup are cropped; UI-tree and terminal evidence are retained instead.

After explicit user authorization, the whole Orca desktop was stopped and
restarted. The exact Pi process, PTY host and session survived; the new runtime
recognized the same Pi tab. The original native supervisor question was answered,
and its original task/dispatch completed successfully with one native start.
The test exposed that `orca status` can exit successfully while its runtime is
unreachable. Both dispatch preflight and workflow health now check the returned
runtime reachability. A second actual outage confirmed disconnected health while
the same Pi continued; `Test-AdapterRecovery.mjs` also covers this regression.
Recovery still requires the original coordinator and dispatch-assignee panes;
if they are missing or ambiguous, it reports the precise restoration requirement
and blocks replacement. This test does not claim recovery from deleted panes.

The visible-Orca skill selection was changed only after the single real scout
lifecycle passed. Bare tool calls keep the compatible headless/native defaults.
`orcaProgressTabs` remains unset and therefore disabled; its Windows exclusion
matches the original npm source byte-for-byte. The original npm installation, logs,
historical backups and Herdr file views remain intact.

Native stop retains upstream semantics: it targets running execution. An
already interrupted attempt is retained as paused for resume; stop on that
settled paused artifact returns the native invalid-state error. Test cleanup
retired the corresponding test processes explicitly without rewriting paused
native results. This distinction is visible, not hidden behind a false stop ack.
