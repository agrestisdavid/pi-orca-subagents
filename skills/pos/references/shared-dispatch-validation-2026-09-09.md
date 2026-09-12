# Shared dispatch / Pi tab — Windows validation, 2026-09-09

Current backend `0.66.0-pi-bots.3`, Orca `1.4.196`. Evidence paths are relative
to `<previous Pi workspace>\tests\pi-bots-orca\`.

## Default shared layout and configurable stop on close (version .3)

| Check | Evidence |
|---|---|
| No layout option: real Pi in original dispatch pane, two total tabs, Pi recognition, todo, native question/TUI answer, original dispatch succeeds | `shared-dispatch-1788940005181/result.json` |
| Closing shared tab stops native scout with parent offline; Pi and PTY broker exit | `tab-close-default-1788939818761/result.json` |
| Immediate sync after closing cannot create a replacement view or bypass native stop | `tab-close-sync-race-1788940297386/result.json` |
| Two parallel children: extra tab stops only its child; shared tab stops workflow with parent offline | `tab-close-parallel-1788939925747/result.json` |
| Live preference false preserves Pi; sync reconnects exact process/session; setting true retires completed process on later close | `tab-close-detach-1788939863973/result.json` |
| View transport process loss reconnects in the same tab; Pi and completed dispatch unchanged | `shared-dispatch-1788940005181/transport.json` |
| Reachability failure, invalid inventory and a changed runtime with missing tabs do not imply close; settings and durable native stop delivery | Fork `npm test` |
| Settings command on/off preserves unrelated settings; native RPC receipts and cancellation regressions | `npm run test:wrapper` |

`piBots.stopOnTabClose` defaults to true and is explicitly enabled in the user's
settings. `/pi-bots-settings` controls it. Shared dispatch-pane close cancels the
Orca dispatch and stops the whole native workflow; another child pane stops
only that child. False preserves native execution, but does not revive an
Orca dispatch cancelled by closing its pane. Old, already launched .2 hosts
retain their loaded code; reload Pi and start new children for the new behavior.

## Earlier version .2 validation

| Check | Evidence |
|---|---|
| Real scout TUI in the original dispatch pane; two tabs total; public `dispatchView: "shared"` option | `shared-dispatch-1788935869944/result.json` |
| Official Pi recognition, native todo, question and TUI answer; original dispatch succeeds | Same single-scout report |
| Two parallel children, dynamic third child, exactly one shared pane and four total tabs | `workflow-1788935320110/result.json` |
| Shared adapter restart without shell text in Pi chat; parent reload | Same workflow report |
| Resume retains exact session, retires old writer and gives the new completed-workflow continuation its own dispatch | `resume-1788935438290/result.json` |
| Concurrent claim ownership, resume ownership, legacy layout preservation | Fork `npm test`, eight passing tests |
| Headless layout rejection before native start; receipt/cancellation regressions | `Test-PiBotsExtension.mjs`, `Test-AdapterRecovery.mjs` |
| Existing separate adapter restart still works | `adapter-restart-1788935642235/result.json` |
| Shared-pane close limitation reproduced as an expected lifecycle assertion | `dispatch-pane-closure-1788935774136/result.json` |

## Confirmed close limitation

The model-free probe `dispatch-pane-closure-1788934550262/after-pane-closure.json`
shows that closing the dispatch pane settles it as failed with
`termination_reason: operator_close`. Restoring its exact adapter does not undo
that: the original completion receives `inactive_dispatch`. This is an actual
Orca lifecycle result, not a transport timeout assumption. Pi's independently
owned process may continue, but the original Orca dispatch cannot be resumed
by opening another view. Version .3 now couples this operator close to native
workflow stop by default, following the user's chosen close behavior.

Version .2 required `dispatchView: "shared"`; version .3 makes shared the default
for new Orca TUI workflows. Existing mappings retain their layout. No Orca runtime files or official status
hooks were modified. The coordinator remains a separate technical tab.

The failed initial prototype `shared-dispatch-1788934949546` is retained:
a circular module import prevented initial attachment and the native startup
deadline expired. The import was corrected; the subsequent successful report
above uses a fresh, conclusively separate test workflow. That failed test's
unused Pi process and views were explicitly retired.
