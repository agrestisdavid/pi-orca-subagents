# Pi Bots

For requested visible Orca agents use `execution: "orca-tui"`,
`coordination: "orca"`, and `viewMode: "orca"` (or `"both"` when Herdr is
also wanted). The single-scout acceptance test passed; use this path for real
Pi TUIs. Existing calls without these options retain `headless` and `native`.

A child has one actual AgentSession, one Pi process, and one Windows ConPTY
host. Its Orca tab carries Pi's terminal input/output. It is interactive:
reading, navigation, steering and Escape operate on that same child.
The parent retains native FleetView and workflow control.

The first child uses the workflow dispatch pane by default; additional children
get one new Pi tab when no assigned dispatch tab is free. No layout option is
required. The invoking Orca parent is the coordinator; its adapter runs in the
background without another visible tab. Existing workflow mappings keep
their original layout; `dispatchView: "separate"` remains a compatibility option.

Closing a child tab **stops its native child by default**. Closing the shared
Pi/dispatch tab stops the **whole native workflow**, because Orca cancels its
dispatch on operator close. The closed Pi process and its PTY host retire after
native cancellation is confirmed. Other open TUIs stay readable after stopping.

Use `/pi-bots-settings` to change this preference, or
`/pi-bots-settings stop-on-tab-close off` / `on`. It is stored in
`~/.pi/agent/settings.json` as `piBots.stopOnTabClose` (default `true`).
New backend hosts read it at close time, including already running children.
With `false`, tab closing only detaches the native child; `sync_views` reconnects
the same session. Closing the shared pane still cancels its Orca dispatch.
Never promise that a new view restores that cancelled dispatch or create a
replacement to hide its outcome. Transport loss or an Orca outage is not a tab close.

## Host reliability

- Existence checks for a recorded tab run in that tab's own workspace: the
  shared dispatch tab is looked up in the workflow area, a separately created
  child tab in its own working area. Identity is still verified by
  terminal/tab/pane key. "Not found in another worktree's inventory" is never
  evidence of a close.
- An unknown inventory (connection error, unreachable Orca, runtime restart,
  ambiguous match) means unknown, not closed. Only two consecutive confirmed
  absences in the correct workspace of the same reachable Orca runtime
  confirm a close, at startup and during monitoring alike.
- The host's file exchange retries only matching transient Windows rename
  locks (EPERM/EACCES/EBUSY) on a short 10/25/50/100 ms ladder (at most
  185 ms per exchange); a persistent failure surfaces the original error.
  File retries never restart an agent.
- A terminal host error stays terminal: a late `ready` or `state` message is
  ignored and logged. Release and cleanup keep working.
- Status waves are published only when the relevant state changes (child
  identity, run state, tab connection, error). Failed children are announced
  once per transition with run ID, child, compact cause, and results so far,
  even while other children of the workflow are still running. Full stack
  traces stay in the run artifacts.

## Start

```typescript
pi_bots({
  action: "start",
  execution: "orca-tui",
  coordination: "orca",
  viewMode: "orca",
  launch: {
    agent: "scout",
    context: "fresh",
    task: "Inspect the assigned files and report findings."
  }
})
```

Use native discovery, preflight, role profiles, writer isolation and budgets.
Native `workflowScript` is supported, including parallel and dynamic children.
Do not force `chatProgress: "live-card"`; leave native FleetView selection on
`auto`. Parents without a TUI use native textual status instead of FleetView.
Do not enable `orcaProgressTabs` or modify its Windows exclusion.

Pi Bots starts through the versioned native RPC only after Orca confirms one
Run, Task and Dispatch for the whole workflow. Model-free coordinator and
workflow adapters use the verified parent and dispatch identities. A parent
running outside Orca needs a dedicated coordinator endpoint. Each real child also appears as Pi in Orca's Agents and
Agent Dashboard. Children have no additional dispatches. Never borrow a
focused or unrelated terminal.

If Orca, its exact working-directory registration, or the local backend is
missing, report the concrete start error. Do not silently substitute a viewer.

## Profiles

Use installed native profiles and the user’s configured model overrides. POS does not ship personal provider credentials or private model endpoints.

## Child controls and Todo

- During work, ordinary input goes to the actual child conversation. Escape
  interrupts the active child and the native run reports the interruption.
- Use native `steer`, `interrupt` and `stop` through FleetView, `subagent`,
  or the corresponding `pi_bots` actions. Stop is explicit; Orca
  `worker-stop` does not own these processes.
- Each child explicitly loads the POS-bundled `rpiv-todo`. It must create its own short plan
  before other work, mark current steps in progress and update completion.
  Initially only `todo` is offered to the model; successful plan creation
  restores exactly the originally active work tools. Clearing the plan closes
  that gate again, and failed Todo calls never unlock it.
  Parent todos are not its plan. A capability ceiling that excludes `todo`
  or required extensions causes a clear start conflict.
- After native completion, the open TUI stays readable. Further input or
  `/bot-resume <task>` requests native resume through the parent. It does not
  start an untracked model turn.
- `/new`, `/fork` and unmanaged session switching cannot detach ownership.
  Use coordinated resume. The previous writer must have exited before the
  same session file is opened by the resumed attempt.
- With `piBots.stopOnTabClose: false`, use
  `pi_bots({action:"sync_views",runId:"<exact-native-id>"})` to reconnect a closed
  view without a second child session or model prompt. With the default `true`,
  a stopped child requires native resume for further work; sync does not restart it.

## Supervisor questions

Use the `subagent-decisions` protocol when decisions may be needed.
`contact_supervisor` in the child and native `subagent_supervisor` remain
canonical. The parent can use `supervisor_pending` and `supervisor_reply`
through Pi Bots for its managed TUI children. The child tab also accepts
`/bot-reply <answer>` when exactly one native question is pending.

All these routes invoke the same native answer handler and request ID.
Only the first confirmed answer wins. Pi Bots mirrors native questions and
confirmed answers into Orca. Treat both notices as one question. An Orca-only
reply is insufficient to unblock native Pi. A child-tab request waits in the
parent's durable queue when the parent is offline; it is not falsely confirmed.

## Recovery and dispatch ownership

Original spawn/resume request IDs, native runs, child attempts, session files,
PTY hosts and Orca identities are journaled. Lost responses are read from
durable receipts; do not repeat starts or resumes while their outcome is
unknown. Workflow scripts run in a persistent model-free native owner, so a
parent reload does not kill the in-progress JavaScript workflow.

Each paused workflow keeps its active dispatch when resumed. Resuming an
already terminal workflow creates a new workflow dispatch and leaves its
previous result unchanged. Native success maps to Orca `worker_done/succeeded`;
error, partial result and stop map to `worker_done/failed`.

The PTY survives transport disconnection. Orca transport failure does not stop
native execution; pending notifications remain queued. Closing a tab follows
the Pi Bots setting; Orca can terminate that tab's protocol adapter process.
`sync_views` also reconciles adapters in their exact original Orca panes.
Missing/ambiguous original coordinator or dispatch panes block replacement.
Do not create a substitute dispatch to hide a recovery failure.

State is stored under the native temp root: `pi-bots-state/<parent-hash>/`,
`rpc-receipts-v1/`, `tui-session-owners/`, `tui-workflow-controls/`, and
`<asyncDir>/tui/`. Preserve these records and their logs.

Validation and remaining limits:
[Windows TUI acceptance](native-tui-validation-2026-09-09.md).
A whole Orca desktop restart across a changed runtime was tested with one real
scout: the same Pi/PTY/session survived, and its original question and dispatch
completed. Recovery requires the original coordinator and assignee panes.

## Herdr and legacy headless views

Herdr remains a read-only file-based chat viewer. In `headless` mode the
existing Orca file viewer also remains available; it is not a Pi TUI.

`Publish-PiBotView.ps1` / `Watch-PiBot.ps1` use the exact native child session,
with labeled transcript/output fallbacks. They page through available JSONL
history, separate inherited fork context, mark truncated/missing data and
never reconstruct absent contents.

For Herdr, match the canonical native CWD to exactly one workspace checkout,
create only a new tab with `--no-focus`, and save its workspace/tab/pane IDs.
No focused-workspace fallback or input to existing foreign panes. For a TUI
workflow, the legacy publisher may add Herdr only (`-NoOrca`).

Orca orchestration remains distinct from Herdr's optional file views.

## Finishing and closing views

Validate native results first. Leave completed TUIs available for reading.
If the user requested closure, use `cleanup_preflight` and then
`cleanup_views` with `confirm: true`. An existing user instruction to close
the owned views is sufficient; do not ask again. Otherwise leave them open.

Cleanup verifies exact recorded identities and closes only owned views.
TUI closure follows `piBots.stopOnTabClose`, including native workflow stop
for the shared dispatch pane. The returned stop is pending until native status
confirms it. Herdr/headless file-view closure still does not stop children.
Unknown ownership blocks cleanup.
