# pi-orca-subagents (POS)

A complete fork of [pi-subagents](https://github.com/nicobailon/pi-subagents),
combining its native delegation and background engine with interactive Pi TUIs
in Orca. Based on upstream **0.66.0**, including the maintained local TUI,
durable workflow, shared-dispatch and tab-close changes.

## Install

Requires Node.js 24.14+ and Pi (validated with 0.85.1). From Pi's environment:

```sh
pi install git:github.com/agrestisdavid/pi-orca-subagents@pos-main
```

Reload Pi, then use `/pos <task>` or `/skill:pos`. Orca TUIs are the POS
default. Headless/native delegation works without Orca. For interactive TUIs,
install Orca and let it provision its official Pi status hook. A custom hook
location can be supplied through `POS_ORCA_STATUS_EXTENSION`. The target
working directory must be registered in Orca. Windows is the tested TUI platform.

On Windows, automatic worktree allocation uses Git directly. To use Worktrunk,
set `PI_SUBAGENTS_WORKTRUNK_BIN` to its absolute executable path. POS never probes
the ambiguous Windows `wt` command, which commonly launches Windows Terminal.

**No separate pi-subagents or Todo installation is needed.** POS installs
`@juicesharp/rpiv-todo` (including `rpiv-config`), `@earendil-works/pi-server`,
`node-pty`, `acorn`, `jiti`, `typebox`, `undici` and `yaml` automatically.
Pi SDK packages are host peers. Each interactive child loads the bundled Todo;
an ambient copy of the same package is deduplicated. Herdr and its views are optional.

Do not enable this package alongside the old pi-subagents or Pi-Bots extension:
they register the same native tools. For the previous maintained local setup,
run `node migrate-local.mjs` from a checked-out POS repository after
`npm ci` and tests. It preserves settings, backs up the old wrapper and skills,
and replaces the old package selection. Active TUI/workflow hosts block migration.
Reload Pi afterwards. To roll back, restore the reported settings backup and
move the files recorded in its `moves.json` back to their original paths.

## Updates

For a Git-installed POS package tracking `pos-main`, update it with:

```sh
pi update --extensions
```

To update only POS, use:

```sh
pi update git:github.com/agrestisdavid/pi-orca-subagents@pos-main
```

Pi 0.85.1 fetches the configured Git ref on update. The moving `pos-main`
branch therefore receives new commits; a fixed release tag or commit stays
on that version. Reload Pi after updating and start fresh child sessions.
No npm publication is needed.

A local folder installation is a development checkout and is not updated by
these commands. To switch an existing POS development installation to Git,
finish active POS work, remove its local **package selection** with
`pi remove /absolute/path/to/pi-orca-subagents`, then run the Git installation
command above and reload Pi. Removing a local package selection preserves
the source folder. Keep source edits in that development checkout: Pi owns
and may reset/clean its separate managed Git installation during updates.

## Features and compatibility

- Single delegation, foreground and background execution, completion notices,
  external jobs, FleetView, scripted parallel/dynamic workflows and profiles.
- Native budgets, capability ceilings, writer isolation and supervisor controls.
- Actual interactive Pi child sessions in Orca, with Todo, durable ownership,
  receipt-based recovery, stop/interrupt/resume and dispatch reconciliation.
- One tab per child when launched from Pi in Orca: the child uses its assigned
  dispatch tab, or gets one new Pi tab. The parent coordinates through a
  background adapter, without an additional coordinator tab per launch.
  Pi launched outside Orca needs a dedicated coordinator endpoint.
  Closing a tab stops owned work by default;
  `/pi-bots-settings stop-on-tab-close off` changes that preference.
- Existing `subagent`, `pi_bots`, Background tools and administrative commands
  remain available. Package API subpaths retain their names under
  `pi-orca-subagents/*`. Settings and stored run IDs are preserved.

See [POS skill](skills/pos/SKILL.md), [native API guide](docs/UPSTREAM-README.md),
[workflow guide](docs/workflows.md) and [TUI backend notes](PI-BOTS.md).
Personal profiles and model overrides remain in the Pi user directory; no
credentials or personal model settings are bundled.

## Development

```sh
npm ci
npm test
npm run test:unit
npm run test:integration
npm run typecheck
```

Live Orca fixtures in `skills/pos/scripts/Test-*.mjs` require a running Orca
and explicitly configured test models. Run from this repository; use
`POS_TEST_CWD` for an Orca-registered disposable test project. These fixtures
may launch real model calls; deterministic tests do not.

## License and provenance

MIT; original pi-subagents copyright belongs to Nico Bailon. Original history,
license, public APIs and upstream tests are retained. Bundled dependencies
retain their own licenses. POS's public branch is `pos-main`; `upstream` tracks
the original repository. No npm publication is required for Git installation.
