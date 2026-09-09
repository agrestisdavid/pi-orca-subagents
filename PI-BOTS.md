# Local Pi Bots child execution backend

Maintained fork: **0.66.0-pi-bots.2**, based on the complete installed upstream
**pi-subagents 0.66.0**. Its initial Git commit is the unmodified upstream
baseline. The installed npm copy is not patched. Windows, Node 24.14.0,
Pi SDK 0.85.1, node-pty 1.1.0 and Orca 1.4.196 were used for validation.

## Install and restore

From this directory run `./install-local.ps1`. It performs a locked `npm ci`,
runs the authority tests, backs up `agent/settings.json`, and replaces only
the pi-subagents package selection with this local source. Reload Pi afterwards.
`./install-local.ps1 -RestoreUpstream` restores `npm:pi-subagents@0.66.0`.
`-SkipDependencies` is available after dependency installation/tests have already
passed. Existing agent overrides and `orcaProgressTabs` settings are preserved.
The upstream published package refers to development tests absent from its
distribution; this fork supplies a separate `test:tui` suite and does not claim
to have run the unpublished upstream suite.

## Supported integration boundary

Pi Bots sends native RPC `spawn`/`resume` with an optional `childExecution`:

```typescript
{
  version: 1,
  type: "orca-tui",
  coordinationRoot: "<absolute confirmed Orca workflow directory>",
  parentJournal: "<absolute Pi Bots parent journal>",
  todoExtension: "<absolute installed rpiv-todo extension>",
  statusExtension: "<absolute installed official Orca Pi hooks>"
}
```

`ping.capabilities.childExecution` advertises this protocol. Omission preserves
the upstream headless factory. AsyncLocalStorage scopes selection to the native
call; detached native runners receive the same serialized selection.
Native tool planning injects the two explicit extensions and `todo` before
capability validation, including inherited ceilings. A conflict fails clearly.

The existing native factory still resolves models, resources, tools,
permissions, context and session storage. Its `onSessionCreated` callback lets
the child process mount **Pi InteractiveMode** on that same AgentSession.
Native child hooks are reconstructed there from their typed runtime data;
callbacks return through the protocol. No function objects cross processes.

## Ownership and controls

Each child attempt owns a detached Node broker, one Windows ConPTY, and exactly
one Pi process. `attach.mjs` forwards actual terminal bytes and input; it does
not render a chat viewer. The broker survives view closure and parent exit.
Pi owns scrolling, tool cards, input, navigation and the todo widget.

`agent-host.ts` binds the native child hooks and Pi UI. It gates work on a
successful child-owned `todo create`. Direct input during execution is part of
the actual session. Escape is reported through native run interruption state.
Free input after completion and `/bot-resume` enqueue a coordinated native
resume; `/new`, `/fork` and unmanaged session switching are blocked.
`/bot-reply` and parent replies use one canonical supervisor handler/request ID.
Child UI requests remain pending if the parent is offline.

Ordinary completed children retain their TUI for reading. The native
process-terminal proof truthfully reports an unverified writer closure while
that Pi process remains alive. Resume retires the previous attempt and waits
for its observed process exit before opening the same session file. It claims
the next session owner before process startup. An unknown owner blocks another
writer. Native read-only continuation certification is not fabricated for a
still-open TUI; native fail-closed policy remains in force.

Background task mutation arbitration uses the real child's native model
services, through a bounded protocol operation. It does not bypass upstream
mutation guards. The persistent workflow owner cannot execute a parent model
prompt: both its session and agent prompt functions reject such calls.

For `workflowScript`, a detached model-free host runs the original native
JavaScript workflow executor. It preserves the original parent ownership key
while reading an exact context snapshot. Its native controls, supervisor
handler and live workflow closure survive parent reload. Global role/profile
files remain the source of agent definitions. Runtime-only custom definitions
registered by another parent extension are not copied into this isolated host;
use persisted native profiles for this backend.

## Durable transport and Orca

The local v1 JSON protocol uses an authenticated loopback socket. Control
commands have receipts keyed by original request ID. Sequenced events are
journaled and replayed before live events resume. Reconnection retries only the
same original command; lost connections never issue a replacement prompt.
The 64 MB per-frame limit is a transport limit, not a 256 KB history truncation.
An oversized frame produces an error instead of inventing a complete history.

Native RPC spawn/resume claims are persisted before mutation. Replies settle
before emission and cannot be overwritten by a failing reply listener.
Read-only `receipt` queries recover completed requests after parent death,
including the persistent workflow host's original inner receipt. A claim with
no conclusive receipt stays blocked.

Pi Bots owns one Orca Run/Task/Dispatch per workflow. Dedicated model-free
protocol adapters represent its coordinator and assignee; each real Pi child
additionally registers through the unmodified official Orca status extension.
Inherited Orca/Herdr identities are stripped before child startup. Reattachment
updates the actual child's official hook identity to its own current tab.
The child/session/attempt/native run/PTY/Orca IDs are retained together.

Pi Bots supports `dispatchView: "shared" | "separate"` for Orca TUI execution.
`shared` uses a durable first-child claim to present the real Pi TUI in the
workflow's existing dispatch pane. Further parallel/dynamic children get their
own panes. One scout uses two total tabs (coordinator plus Pi/dispatch), and
three children use four. The native process/session factory is unchanged.
The shared adapter restarts through its verified saved binding; no shell
commands are typed into the Pi chat. A native resume can reuse the slot only
after the prior writer's observed exit. Existing mappings retain their layout.

**Closing the shared dispatch pane aborts its Orca dispatch.** The installed
Orca marks it failed with `termination_reason: "operator_close"`, and later
`worker_done` fails with `inactive_dispatch`. Native Pi may continue under its
independent PTY, but this is not a recoverable Orca view detachment. Keep the
shared pane open until the whole workflow settles. `separate` retains the
previous detachable-child behavior. Shared mode is currently explicit opt-in;
the default has not changed pending the user's choice about this close behavior.

Protocol adapters are detached from terminal processes. Their durable spool
survives parent or terminal loss, and acknowledged dead adapters can restart
in their original panes. `sync_views` resolves an existing pane using its
stored tab and leaf identity. Missing or ambiguous coordinator/assignee panes
block replacement rather than allocate another dispatch. Orca CLI operations
with an unknown outcome and no returned request ID remain blocked. This is an
explicit recovery limitation, not evidence that no operation happened.

Actual child completion, native question, confirmed answer and workflow
success/failure are mirrored through official hooks and orchestration commands.
Native Pi owns stopping. Closing a child view only disconnects its terminal.
Explicit test cleanup additionally retires only verified owned test processes.

## Validation and limits

Authority tests: `npm test`. Wrapper checks: `npm run test:wrapper`.
Live tests are in `../../skills/pi-bots/scripts/Test-Tui*.mjs` and
`Test-AdapterRestart.mjs`; run them from `C:\Users\david\.pi` against the
isolated Orca-managed `tests/pi-bots-orca` fixture. Live scout tests use the
configured model and incur its normal usage. History/adapter fixtures clearly
mark synthetic data and require no model calls.

The acceptance matrix and evidence paths are recorded in
`../../skills/pi-bots/references/native-tui-validation-2026-09-09.md`.
Tab detach/reattach, parent reload, lost local connections/receipts, adapter
process restart and a complete Orca desktop restart into a new runtime are
tested. The desktop restart retained the exact Pi process, PTY and session;
its original supervisor question and dispatch completed after reconnection.
An actual outage also confirmed disconnected health while Pi kept running.
Orca status exit success alone is insufficient: the adapter and dispatch
preflight require the returned runtime to be reachable. If Orca fails to
restore the original coordinator/assignee panes, stable dispatch actor
restoration is the missing interface; a viewer or new dispatch is not a substitute.

Herdr retains the existing paged file viewer. `orcaProgressTabs` remains off,
and its Windows exclusion is unchanged. No managed Orca status-hook file or
installed npm `node_modules/pi-subagents` file is edited by this integration.
