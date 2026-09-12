[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
    Write-Output "PASS: $Message"
}

function Write-Utf8 {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Decode-ViewerCommand {
    param([Parameter(Mandatory = $true)][string]$Command)
    $match = [regex]::Match($Command, '(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/=]+)$')
    if (-not $match.Success) { throw "Viewer command is not an encoded PowerShell command: $Command" }
    return [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($match.Groups[1].Value))
}

function Invoke-PowerShellScript {
    param([string]$Script, [string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = (& $script:PowerShellExecutable -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Script @Arguments 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    return [pscustomobject]@{ ExitCode = $exitCode; Raw = $raw }
}

function Reset-SurfaceState {
    Write-Utf8 $env:PI_BOTS_TEST_HERDR_STATE '{"tabs":[],"commands":[]}'
    Write-Utf8 $env:PI_BOTS_TEST_ORCA_STATE '{"terminals":[],"commands":[]}'
}

function Invoke-TestPublisher {
    param([string]$RecordRoot, [string[]]$ExtraArguments = @())
    $arguments = @(
        '-RunId', 'test123', '-AsyncDir', $script:AsyncDir, '-ChildIndex', '0',
        '-Title', "Pi Bot O'Brien & [test]", '-HerdrExecutable', $script:HerdrCmdPath,
        '-OrcaExecutable', $script:OrcaCmdPath, '-RecordRoot', $RecordRoot,
        '-WatcherMaxRefreshes', '1'
    ) + $ExtraArguments
    return Invoke-PowerShellScript -Script $script:Publisher -Arguments $arguments
}

function Invoke-TestCloser {
    param([string]$RecordRoot, [switch]$PreflightOnly)
    $arguments = @(
        '-RunId', 'test123', '-HerdrExecutable', $script:HerdrCmdPath,
        '-OrcaExecutable', $script:OrcaCmdPath, '-RecordRoot', $RecordRoot
    )
    if ($PreflightOnly) { $arguments += '-PreflightOnly' }
    return Invoke-PowerShellScript -Script $script:Closer -Arguments $arguments
}

$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:PowerShellExecutable = if (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf) { $windowsPowerShell } else { (Get-Process -Id $PID).Path }
$testedPowerShellMajor = [int]((& $script:PowerShellExecutable -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.Major' | Select-Object -Last 1))
Assert-True ($testedPowerShellMajor -eq 5) 'integration scripts execute under Windows PowerShell 5.1'
$nodeCommand = Get-Command node -ErrorAction Stop | Select-Object -First 1
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-bots-test-" + [guid]::NewGuid().ToString('N'))
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).Path
if (-not $resolvedTestRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not ([System.IO.Path]::GetFileName($resolvedTestRoot)).StartsWith('pi-bots-test-')) {
    throw "Unsafe test directory: $resolvedTestRoot"
}

try {
    $fixtureDir = Join-Path $resolvedTestRoot 'fixtures'
    $projectDir = Join-Path $resolvedTestRoot "project space & O'Brien"
    $script:AsyncDir = Join-Path $resolvedTestRoot "async space & O'Brien\run-test123"
    New-Item -ItemType Directory -Force -Path $fixtureDir, $projectDir, $script:AsyncDir | Out-Null

    $herdrJs = @'
const fs = require("fs");
const args = process.argv.slice(2);
const statePath = process.env.PI_BOTS_TEST_HERDR_STATE;
const projectPath = process.env.PI_BOTS_TEST_PROJECT_DIR;
const mode = process.env.PI_BOTS_TEST_HERDR_MODE || "match";
const load = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { tabs: [], commands: [] };
const save = value => fs.writeFileSync(statePath, JSON.stringify(value), "utf8");
const emit = result => process.stdout.write(JSON.stringify({ id: "test", result }));
if (args[0] === "workspace" && args[1] === "list") {
  if (mode === "fail") { process.stderr.write("simulated workspace-list failure"); process.exit(9); }
  const other = projectPath + "-other";
  const item = (id, checkout) => ({
    workspace_id: id, number: 1, label: id, focused: false, pane_count: 1, tab_count: 1,
    active_tab_id: id + ":t0", agent_status: "idle",
    worktree: { repo_key: "repo", repo_name: "repo", repo_root: checkout, checkout_path: checkout, is_linked_worktree: false }
  });
  let workspaces = [];
  if (["match", "runfail", "badlink", "missingids", "missingidsuntagged", "badlinkclosefail", "createexit"].includes(mode)) workspaces = [item("w-match", projectPath)];
  else if (mode === "ambiguous") workspaces = [item("w-one", projectPath), item("w-two", projectPath)];
  else if (mode === "nomatch") workspaces = [item("w-other", other)];
  emit({ type: "workspace_list", workspaces });
} else if (args[0] === "tab" && args[1] === "create") {
  const delay = Number(process.env.PI_BOTS_TEST_CREATE_DELAY_MS || 0);
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  const state = load();
  const ordinal = state.tabs.length + 1;
  const workspaceIndex = args.indexOf("--workspace");
  const labelIndex = args.indexOf("--label");
  const workspaceId = args[workspaceIndex + 1];
  const tab = { tab_id: `${workspaceId}:t${ordinal}`, workspace_id: workspaceId, number: ordinal, label: args[labelIndex + 1], focused: false, pane_count: 1, agent_status: "idle" };
  const root_pane = { pane_id: `${workspaceId}:p${ordinal}`, tab_id: tab.tab_id, workspace_id: workspaceId };
  if (mode === "missingidsuntagged") tab.label = "rewritten-title";
  state.tabs.push(tab); save(state);
  if (mode === "createexit") { process.stderr.write("simulated post-create command failure"); process.exit(5); }
  if (mode === "missingids" || mode === "missingidsuntagged") emit({ type: "tab_created", tab: {}, root_pane: {} });
  else if (mode === "badlink" || mode === "badlinkclosefail") emit({ type: "tab_created", tab, root_pane: { ...root_pane, tab_id: "wrong-tab", workspace_id: "wrong-workspace" } });
  else emit({ type: "tab_created", tab, root_pane });
} else if (args[0] === "pane" && args[1] === "run") {
  if (mode === "runfail") { process.stderr.write("simulated pane-run failure"); process.exit(8); }
  const state = load(); state.commands.push({ paneId: args[2], command: args.slice(3).join(" ") }); save(state);
  emit({ type: "pane_run", pane_id: args[2] });
} else if (args[0] === "tab" && args[1] === "list") {
  if (process.env.PI_BOTS_TEST_HERDR_LIST_FAIL === "1") { process.stderr.write("simulated tab-list failure"); process.exit(7); }
  const state = load();
  const workspaceIndex = args.indexOf("--workspace");
  const workspaceId = workspaceIndex >= 0 ? args[workspaceIndex + 1] : "";
  emit({ type: "tab_list", tabs: state.tabs.filter(tab => !workspaceId || tab.workspace_id === workspaceId) });
} else if (args[0] === "tab" && args[1] === "close") {
  if (mode === "badlinkclosefail" || process.env.PI_BOTS_TEST_HERDR_CLOSE_FAIL === "1") { process.stderr.write("simulated tab-close failure"); process.exit(6); }
  const state = load(); state.tabs = state.tabs.filter(tab => tab.tab_id !== args[2]); save(state);
  emit({ type: "tab_closed", tab_id: args[2] });
} else {
  process.stderr.write("unsupported herdr command: " + args.join(" "));
  process.exit(4);
}
'@

    $orcaJs = @'
const fs = require("fs");
const args = process.argv.slice(2);
const statePath = process.env.PI_BOTS_TEST_ORCA_STATE;
const projectPath = process.env.PI_BOTS_TEST_PROJECT_DIR;
const mode = process.env.PI_BOTS_TEST_ORCA_MODE || "match";
const load = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { terminals: [], commands: [] };
const save = value => fs.writeFileSync(statePath, JSON.stringify(value), "utf8");
if (args[0] === "worktree" && args[1] === "show") {
  if (mode === "fail") { process.stderr.write("simulated worktree failure"); process.exit(9); }
  const path = mode === "nomatch" ? projectPath + "-other" : projectPath;
  process.stdout.write(JSON.stringify({ ok: true, result: { worktree: { id: `repo::${path}`, path } } }));
} else if (args[0] === "terminal" && args[1] === "create") {
  if (mode === "createfail") { process.stderr.write("simulated terminal-create failure"); process.exit(8); }
  const delay = Number(process.env.PI_BOTS_TEST_CREATE_DELAY_MS || 0);
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  const state = load();
  const ordinal = state.terminals.length + 1;
  const titleIndex = args.indexOf("--title");
  const terminal = { handle: `handle-${ordinal}`, tabId: `orca-tab-${ordinal}`, title: titleIndex >= 0 ? args[titleIndex + 1] : "", surface: "terminal" };
  const commandIndex = args.indexOf("--command");
  if (mode === "missingidsuntagged") terminal.title = "rewritten-title";
  state.terminals.push(terminal); state.commands.push(commandIndex >= 0 ? args[commandIndex + 1] : ""); save(state);
  if (mode === "createexit") { process.stderr.write("simulated post-create command failure"); process.exit(6); }
  const returned = mode === "badidentity" ? { ...terminal, handle: "wrong-handle", tabId: "wrong-tab" } : (mode === "missingidsuntagged" ? {} : terminal);
  process.stdout.write(JSON.stringify({ ok: true, result: { terminal: returned } }));
} else if (args[0] === "terminal" && args[1] === "list") {
  if (process.env.PI_BOTS_TEST_ORCA_LIST_FAIL === "1") { process.stderr.write("simulated terminal-list failure"); process.exit(7); }
  process.stdout.write(JSON.stringify({ ok: true, result: load() }));
} else if (args[0] === "terminal" && args[1] === "close") {
  if (process.env.PI_BOTS_TEST_ORCA_CLOSE_FAIL === "1") { process.stderr.write("simulated terminal-close failure"); process.exit(6); }
  const handleIndex = args.indexOf("--terminal");
  const handle = handleIndex >= 0 ? args[handleIndex + 1] : "";
  const state = load(); state.terminals = state.terminals.filter(item => item.handle !== handle); save(state);
  process.stdout.write(JSON.stringify({ ok: true, result: { closed: handle } }));
} else {
  process.stderr.write("unsupported orca command: " + args.join(" "));
  process.exit(5);
}
'@

    $herdrJsPath = Join-Path $fixtureDir 'fake-herdr.js'
    $orcaJsPath = Join-Path $fixtureDir 'fake-orca.js'
    $script:HerdrCmdPath = Join-Path $fixtureDir 'herdr.cmd'
    $script:OrcaCmdPath = Join-Path $fixtureDir 'orca.cmd'
    Write-Utf8 $herdrJsPath $herdrJs
    Write-Utf8 $orcaJsPath $orcaJs
    Write-Utf8 $script:HerdrCmdPath ("@`"$($nodeCommand.Source)`" `"$herdrJsPath`" %*`r`n")
    Write-Utf8 $script:OrcaCmdPath ("@`"$($nodeCommand.Source)`" `"$orcaJsPath`" %*`r`n")

    $statusPath = Join-Path $script:AsyncDir 'status.json'
    $outputPath = Join-Path $script:AsyncDir 'output-0.log'
    $status = [ordered]@{
        lifecycleArtifactVersion = 3
        runId = 'test123'
        mode = 'workflow'
        state = 'running'
        cwd = $projectDir
        startedAt = 1
        steps = @([ordered]@{
            agent = 'worker'
            status = 'running'
            activityState = 'tool'
            sessionFile = (Join-Path $script:AsyncDir 'child-session.jsonl')
        })
    }
    Write-Utf8 $statusPath ($status | ConvertTo-Json -Depth 20)
    Write-Utf8 $outputPath "Task: test`nread: src/example.ts`nworking"

    $env:PI_BOTS_TEST_HERDR_STATE = Join-Path $fixtureDir 'herdr-state.json'
    $env:PI_BOTS_TEST_ORCA_STATE = Join-Path $fixtureDir 'orca-state.json'
    $env:PI_BOTS_TEST_PROJECT_DIR = $projectDir
    $env:PI_BOTS_TEST_HERDR_MODE = 'match'
    $env:PI_BOTS_TEST_ORCA_MODE = 'match'
    Remove-Item Env:PI_BOTS_TEST_HERDR_LIST_FAIL -ErrorAction SilentlyContinue
    Remove-Item Env:PI_BOTS_TEST_ORCA_LIST_FAIL -ErrorAction SilentlyContinue
    Remove-Item Env:PI_BOTS_TEST_HERDR_CLOSE_FAIL -ErrorAction SilentlyContinue
    Remove-Item Env:PI_BOTS_TEST_ORCA_CLOSE_FAIL -ErrorAction SilentlyContinue
    Remove-Item Env:PI_BOTS_TEST_CREATE_DELAY_MS -ErrorAction SilentlyContinue
    Reset-SurfaceState

    $script:Publisher = Join-Path $PSScriptRoot 'Publish-PiBotView.ps1'
    $script:Closer = Join-Path $PSScriptRoot 'Close-PiBotViews.ps1'
    $watcher = Join-Path $PSScriptRoot 'Watch-PiBot.ps1'

    function Write-PendingRecordFixture {
        param([Parameter(Mandatory = $true)][string]$RecordRoot, [Parameter(Mandatory = $true)][string]$SurfaceTitle, [Parameter(Mandatory = $true)][string]$Token)
        $recordDirectory = Join-Path $RecordRoot 'test123'
        New-Item -ItemType Directory -Force -Path $recordDirectory | Out-Null
        $pendingRecord = [ordered]@{
            version = 2
            runId = 'test123'
            childIndex = 0
            agent = 'worker'
            title = "Pi Bot O'Brien & [test]"
            surfaceTitle = $SurfaceTitle
            viewToken = $Token
            cwd = $projectDir
            asyncDir = $script:AsyncDir
            statusPath = $statusPath
            outputPath = $outputPath
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            updatedAtUtc = [DateTime]::UtcNow.ToString('o')
            herdr = [ordered]@{ requested = $true; status = 'pending' }
            orca = [ordered]@{ requested = $true; status = 'pending' }
        }
        Write-Utf8 (Join-Path $recordDirectory 'child-0.json') ($pendingRecord | ConvertTo-Json -Depth 20)
    }

    Assert-True (-not (Get-Command $script:Publisher).Parameters.ContainsKey('Cwd')) 'publisher exposes no caller-controlled CWD override'
    $caseMismatch = Invoke-PowerShellScript -Script $script:Publisher -Arguments @(
        '-RunId', 'TEST123', '-AsyncDir', $script:AsyncDir, '-ChildIndex', '0',
        '-Title', 'case mismatch', '-NoHerdr', '-NoOrca', '-RecordRoot', (Join-Path $resolvedTestRoot 'records-case-mismatch')
    )
    Assert-True ($caseMismatch.ExitCode -ne 0) 'publisher rejects a run ID that differs only by case'

    # Both surfaces and idempotence.
    $bothRoot = Join-Path $resolvedTestRoot 'records-both'
    $publish = Invoke-TestPublisher -RecordRoot $bothRoot
    Assert-True ($publish.ExitCode -eq 0) 'publisher succeeds when Herdr and Orca are available'
    $publishJson = $publish.Raw | ConvertFrom-Json
    Assert-True ($publishJson.ok -eq $true) 'publisher returns ok=true'
    Assert-True ($publishJson.hasExternalViews -eq $true) 'publisher reports external views'
    Assert-True ($publishJson.view.herdr.status -eq 'created') 'publisher creates a Herdr spectator'
    Assert-True ($publishJson.view.orca.status -eq 'created') 'publisher creates an Orca spectator'
    Assert-True ($publishJson.view.surfaceTitle -match '\[pb-[0-9a-f]{12}\]$') 'publisher gives created surfaces a unique run-owned token'
    Assert-True ($publishJson.summary -match 'FleetView aktiv') 'publisher keeps FleetView in the summary'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    $orcaState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 1) 'one Herdr tab is created'
    Assert-True ($herdrState.tabs[0].label -eq $publishJson.view.surfaceTitle) 'Herdr tab carries the run-owned surface token'
    Assert-True ($orcaState.terminals[0].title -eq $publishJson.view.surfaceTitle) 'Orca tab carries the same run-owned surface token'
    Assert-True (@($herdrState.commands).Count -eq 1) 'the watcher is started in the new Herdr pane'
    Assert-True ($herdrState.commands[0].command.Contains("& '$script:PowerShellExecutable'")) 'Herdr uses the trusted absolute Windows PowerShell path'
    Assert-True ($herdrState.commands[0].command -match ' -EncodedCommand [A-Za-z0-9+/=]+$') 'Herdr receives an encoded watcher payload'
    $decodedHerdrCommand = Decode-ViewerCommand $herdrState.commands[0].command
    Assert-True ($decodedHerdrCommand -match 'Watch-PiBot.ps1') 'Herdr runs the canonical Pi Bot watcher'
    Assert-True ($decodedHerdrCommand.Contains("async space & O''Brien")) 'Herdr preserves quoted metacharacters in the async path'
    Assert-True ($decodedHerdrCommand.Contains("-Title 'Pi Bot O''Brien & [test]'")) 'Herdr preserves quoted metacharacters in the title'
    Assert-True (@($orcaState.terminals).Count -eq 1) 'one Orca tab is created'
    Assert-True (@($orcaState.commands).Count -eq 1) 'Orca receives one canonical watcher command'
    Assert-True ($orcaState.commands[0] -eq $herdrState.commands[0].command) 'Herdr and Orca watch the same canonical artifacts with the same command'
    $decodedOrcaCommand = Decode-ViewerCommand $orcaState.commands[0]
    Assert-True ($decodedOrcaCommand.Contains("async space & O''Brien")) 'Orca preserves quoted metacharacters in the async path'
    Assert-True ($decodedOrcaCommand.Contains("-Title 'Pi Bot O''Brien & [test]'")) 'Orca preserves quoted metacharacters in the title'
    $encodedWatcherOutput = (& $script:PowerShellExecutable -NoLogo -NoProfile -Command $herdrState.commands[0].command 2>&1 | Out-String)
    Assert-True ($LASTEXITCODE -eq 0 -and $encodedWatcherOutput -match '/ running') 'encoded chat viewer executes through trusted Windows PowerShell'

    $republish = Invoke-TestPublisher -RecordRoot $bothRoot
    Assert-True ($republish.ExitCode -eq 0) 'repeated publication succeeds'
    Assert-True (($republish.Raw | ConvertFrom-Json).reused -eq $true) 'repeated publication reuses the exact record'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    $orcaState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 1 -and @($orcaState.terminals).Count -eq 1) 'idempotence creates no duplicate tabs'

    $runningPreflight = Invoke-TestCloser -RecordRoot $bothRoot -PreflightOnly
    Assert-True ($runningPreflight.ExitCode -eq 2) 'cleanup refuses a running child'
    Assert-True (($runningPreflight.Raw | ConvertFrom-Json).safeToClose -eq $false) 'running cleanup fails closed'

    $status.state = 'complete'
    $status.steps[0].status = 'completed'
    $status.steps[0].activityState = 'idle'
    Write-Utf8 $statusPath ($status | ConvertTo-Json -Depth 20)
    $terminalEscape = [char]27
    $terminalBell = [char]7
    Write-Utf8 $outputPath "Task: test`n${terminalEscape}]0;terminal-title-injection${terminalBell}contact_supervisor: reason=need_decision`n${terminalEscape}[31mfinal result${terminalEscape}[0m"

    $watch = Invoke-PowerShellScript -Script $watcher -Arguments @(
        '-RunId', 'test123', '-AsyncDir', $script:AsyncDir, '-ChildIndex', '0',
        '-Title', "Pi Bot O'Brien & [test]", '-MaxRefreshes', '1'
    )
    Assert-True ($watch.ExitCode -eq 0) 'direct artifact watcher exits successfully'
    Assert-True ($watch.Raw -match 'contact_supervisor: reason=need_decision') 'watcher renders the child output log'
    Assert-True ($watch.Raw -notmatch 'terminal-title-injection') 'watcher strips terminal-control payloads from child output'
    Assert-True ($watch.Raw -match '/ completed') 'chat viewer renders canonical lifecycle state'

    Write-Utf8 $outputPath ("oversized-prefix-marker" + ('x' * 16384) + "bounded-tail-marker")
    $boundedWatch = Invoke-PowerShellScript -Script $watcher -Arguments @(
        '-RunId', 'test123', '-AsyncDir', $script:AsyncDir, '-ChildIndex', '0',
        '-Title', 'Pi Bot bounded output', '-TailBytes', '4096', '-MaxRefreshes', '1'
    )
    Assert-True ($boundedWatch.ExitCode -eq 0) 'paged chat viewer exits successfully'
    Assert-True ($boundedWatch.Raw -match 'bounded-tail-marker') 'last page contains the final output marker'
    Assert-True ($boundedWatch.Raw -match 'FALLBACK: output log only') 'legacy output is explicitly labeled as incomplete fallback'

    $completePreflight = Invoke-TestCloser -RecordRoot $bothRoot -PreflightOnly
    Assert-True ($completePreflight.ExitCode -eq 0) 'terminal run passes cleanup preflight'
    $completePreflightJson = $completePreflight.Raw | ConvertFrom-Json
    Assert-True ($completePreflightJson.safeToClose -eq $true) 'terminal preflight reports safeToClose=true'
    Assert-True ($completePreflightJson.cleanupNeeded -eq $true) 'terminal preflight requests cleanup only for open views'

    $cleanup = Invoke-TestCloser -RecordRoot $bothRoot
    Assert-True ($cleanup.ExitCode -eq 0) 'cleanup succeeds for both surfaces'
    $cleanupJson = $cleanup.Raw | ConvertFrom-Json
    Assert-True ($cleanupJson.closed -eq $true -and $cleanupJson.cleanupNeeded -eq $false) 'cleanup verifies all external views closed'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    $orcaState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 0 -and @($orcaState.terminals).Count -eq 0) 'cleanup leaves no spectator tab'

    $closedPreflight = Invoke-TestCloser -RecordRoot $bothRoot -PreflightOnly
    Assert-True ($closedPreflight.ExitCode -eq 0) 'already-closed views pass preflight'
    Assert-True (($closedPreflight.Raw | ConvertFrom-Json).cleanupNeeded -eq $false) 'already-closed views trigger no cleanup question'

    # Interrupted publication recovery.
    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'match'
    $env:PI_BOTS_TEST_ORCA_MODE = 'match'
    $recoveryRoot = Join-Path $resolvedTestRoot 'records-recovery'
    $recoveryToken = 'abc123def456'
    $recoveryTitle = "Interrupted Pi Bot [pb-$recoveryToken]"
    Write-PendingRecordFixture -RecordRoot $recoveryRoot -SurfaceTitle $recoveryTitle -Token $recoveryToken
    Write-Utf8 $env:PI_BOTS_TEST_HERDR_STATE (([ordered]@{
        tabs = @([ordered]@{ tab_id = 'w-match:recovered'; workspace_id = 'w-match'; label = $recoveryTitle })
        commands = @()
    }) | ConvertTo-Json -Depth 10)
    Write-Utf8 $env:PI_BOTS_TEST_ORCA_STATE (([ordered]@{
        terminals = @([ordered]@{ handle = 'recovered-handle'; tabId = 'orca-recovered'; title = $recoveryTitle; surface = 'terminal' })
        commands = @()
    }) | ConvertTo-Json -Depth 10)
    $recovered = Invoke-TestPublisher -RecordRoot $recoveryRoot
    $recoveredJson = $recovered.Raw | ConvertFrom-Json
    Assert-True ($recovered.ExitCode -eq 0 -and $recoveredJson.reconciled -eq $true) 'pending publication is reconciled after interruption'
    Assert-True ($recoveredJson.view.herdr.tabId -ceq 'w-match:recovered' -and $recoveredJson.view.orca.handle -ceq 'recovered-handle') 'reconciliation persists exact recovered identities'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    $orcaState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 1 -and @($orcaState.terminals).Count -eq 1) 'reconciliation creates no duplicate external views'
    Assert-True (@($herdrState.commands).Count -eq 0 -and @($orcaState.commands).Count -eq 0) 'reconciliation does not relaunch an uncertain watcher'
    Assert-True ((Invoke-TestCloser -RecordRoot $recoveryRoot).ExitCode -eq 0) 'recovered views clean up by exact persisted IDs'

    Reset-SurfaceState
    $pendingEmptyRoot = Join-Path $resolvedTestRoot 'records-pending-empty'
    $pendingEmptyToken = 'def456abc123'
    Write-PendingRecordFixture -RecordRoot $pendingEmptyRoot -SurfaceTitle "Pending Pi Bot [pb-$pendingEmptyToken]" -Token $pendingEmptyToken
    $rawPendingPreflight = Invoke-TestCloser -RecordRoot $pendingEmptyRoot -PreflightOnly
    $rawPendingPreflightJson = $rawPendingPreflight.Raw | ConvertFrom-Json
    Assert-True ($rawPendingPreflight.ExitCode -eq 2 -and $rawPendingPreflightJson.hasExternalViews -eq $true) 'cleanup never treats a raw pending publication as view-free'
    $pendingEmpty = Invoke-TestPublisher -RecordRoot $pendingEmptyRoot
    $pendingEmptyJson = $pendingEmpty.Raw | ConvertFrom-Json
    Assert-True ($pendingEmpty.ExitCode -eq 0 -and $pendingEmptyJson.reconciled -eq $true) 'pending publication without a token match is reconciled fail-closed'
    Assert-True ($pendingEmptyJson.view.herdr.possibleUntrackedTab -eq $true -and $pendingEmptyJson.view.orca.possibleUntrackedTab -eq $true) 'uncertain interrupted surfaces are flagged for manual verification'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    $orcaState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 0 -and @($orcaState.terminals).Count -eq 0) 'pending reconciliation never recreates an uncertain external view'
    $pendingEmptyPreflight = Invoke-TestCloser -RecordRoot $pendingEmptyRoot -PreflightOnly
    Assert-True ($pendingEmptyPreflight.ExitCode -eq 2 -and ($pendingEmptyPreflight.Raw | ConvertFrom-Json).safeToClose -eq $false) 'uncertain pending reconciliation never guesses during cleanup'

    # Concurrent publication claim.
    Reset-SurfaceState
    $concurrentRoot = Join-Path $resolvedTestRoot 'records-concurrent'
    $env:PI_BOTS_TEST_CREATE_DELAY_MS = '1200'
    $jobScript = {
        param($PublisherPath, $AsyncPath, $HerdrPath, $OrcaPath, $RecordsPath)
        try {
            $raw = (& $PublisherPath `
                -RunId 'test123' -AsyncDir $AsyncPath -ChildIndex 0 `
                -Title "Pi Bot O'Brien & [test]" -HerdrExecutable $HerdrPath `
                -OrcaExecutable $OrcaPath -RecordRoot $RecordsPath `
                -WatcherMaxRefreshes 1 2>&1 | Out-String).Trim()
            [pscustomobject]@{ ok = $true; raw = $raw }
        }
        catch { [pscustomobject]@{ ok = $false; raw = $_.Exception.Message } }
    }
    $jobArguments = @($script:Publisher, $script:AsyncDir, $script:HerdrCmdPath, $script:OrcaCmdPath, $concurrentRoot)
    $jobs = @(
        Start-Job -ScriptBlock $jobScript -ArgumentList $jobArguments
        Start-Job -ScriptBlock $jobScript -ArgumentList $jobArguments
    )
    try {
        [void](Wait-Job -Job $jobs -Timeout 90)
        $jobResults = @($jobs | ForEach-Object { Receive-Job -Job $_ })
        Assert-True (@($jobs | Where-Object { $_.State -eq 'Completed' }).Count -eq 2) 'concurrent publishers both finish under the exclusive claim'
        Assert-True (@($jobResults | Where-Object { $_.ok -eq $true }).Count -eq 2) 'concurrent publishers both return successfully'
        $concurrentPayloads = @($jobResults | ForEach-Object { $_.raw | ConvertFrom-Json })
        Assert-True (@($concurrentPayloads | Where-Object { $_.reused -eq $true }).Count -eq 1) 'one concurrent publisher reuses the claimed record'
    }
    finally { $jobs | Remove-Job -Force -ErrorAction SilentlyContinue }
    Remove-Item Env:PI_BOTS_TEST_CREATE_DELAY_MS -ErrorAction SilentlyContinue
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    $orcaState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 1 -and @($orcaState.terminals).Count -eq 1) 'exclusive claim prevents duplicate external views'
    Assert-True ((Invoke-TestCloser -RecordRoot $concurrentRoot).ExitCode -eq 0) 'concurrently published views clean up successfully'

    Reset-SurfaceState
    $publisherCleanupRoot = Join-Path $resolvedTestRoot 'records-publisher-cleanup-race'
    $env:PI_BOTS_TEST_CREATE_DELAY_MS = '1200'
    $publisherCleanupArguments = @($script:Publisher, $script:AsyncDir, $script:HerdrCmdPath, $script:OrcaCmdPath, $publisherCleanupRoot)
    $publisherJob = Start-Job -ScriptBlock $jobScript -ArgumentList $publisherCleanupArguments
    try {
        $pendingRecordPath = Join-Path $publisherCleanupRoot 'test123\child-0.json'
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while (-not (Test-Path -LiteralPath $pendingRecordPath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
        Assert-True (Test-Path -LiteralPath $pendingRecordPath -PathType Leaf) 'publisher writes its pending record while holding the run claim'
        $racingCleanup = Invoke-TestCloser -RecordRoot $publisherCleanupRoot
        [void](Wait-Job -Job $publisherJob -Timeout 90)
        $publisherJobResult = Receive-Job -Job $publisherJob
        Assert-True ($publisherJob.State -eq 'Completed' -and $publisherJobResult.ok -eq $true) 'publisher completes while cleanup waits on the same run claim'
        Assert-True ($racingCleanup.ExitCode -eq 0 -and ($racingCleanup.Raw | ConvertFrom-Json).closed -eq $true) 'cleanup serializes after publication and closes its exact views'
    }
    finally { $publisherJob | Remove-Job -Force -ErrorAction SilentlyContinue }
    Remove-Item Env:PI_BOTS_TEST_CREATE_DELAY_MS -ErrorAction SilentlyContinue
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    $orcaState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 0 -and @($orcaState.terminals).Count -eq 0) 'publisher/cleanup race leaves no external view behind'

    # Fleet-only mode.
    Reset-SurfaceState
    $fleetRoot = Join-Path $resolvedTestRoot 'records-fleet'
    $fleet = Invoke-TestPublisher -RecordRoot $fleetRoot -ExtraArguments @('-NoHerdr', '-NoOrca')
    Assert-True ($fleet.ExitCode -eq 0) 'Fleet-only publication succeeds'
    $fleetJson = $fleet.Raw | ConvertFrom-Json
    Assert-True ($fleetJson.hasExternalViews -eq $false) 'Fleet-only mode reports no external views'
    Assert-True ($fleetJson.view.herdr.status -eq 'skipped' -and $fleetJson.view.orca.status -eq 'skipped') 'Fleet-only mode skips both optional surfaces'
    $fleetPreflight = Invoke-TestCloser -RecordRoot $fleetRoot -PreflightOnly
    Assert-True ($fleetPreflight.ExitCode -eq 0 -and ($fleetPreflight.Raw | ConvertFrom-Json).cleanupNeeded -eq $false) 'Fleet-only mode needs no cleanup prompt'

    # Herdr-only mode.
    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'match'
    $herdrRoot = Join-Path $resolvedTestRoot 'records-herdr'
    $herdrOnly = Invoke-TestPublisher -RecordRoot $herdrRoot -ExtraArguments @('-NoOrca')
    $herdrOnlyJson = $herdrOnly.Raw | ConvertFrom-Json
    Assert-True ($herdrOnly.ExitCode -eq 0 -and $herdrOnlyJson.view.herdr.status -eq 'created') 'Herdr-only spectator succeeds'
    Assert-True ($herdrOnlyJson.view.orca.status -eq 'skipped') 'Herdr-only mode skips Orca'
    $herdrCleanup = Invoke-TestCloser -RecordRoot $herdrRoot
    Assert-True ($herdrCleanup.ExitCode -eq 0 -and ($herdrCleanup.Raw | ConvertFrom-Json).closed -eq $true) 'Herdr-only cleanup succeeds'

    # Orca-only mode.
    Reset-SurfaceState
    $env:PI_BOTS_TEST_ORCA_MODE = 'match'
    $orcaRoot = Join-Path $resolvedTestRoot 'records-orca'
    $orcaOnly = Invoke-TestPublisher -RecordRoot $orcaRoot -ExtraArguments @('-NoHerdr')
    $orcaOnlyJson = $orcaOnly.Raw | ConvertFrom-Json
    Assert-True ($orcaOnly.ExitCode -eq 0 -and $orcaOnlyJson.view.orca.status -eq 'created') 'Orca-only spectator succeeds'
    Assert-True ($orcaOnlyJson.view.herdr.status -eq 'skipped') 'Orca-only mode skips Herdr'
    $orcaCleanup = Invoke-TestCloser -RecordRoot $orcaRoot
    Assert-True ($orcaCleanup.ExitCode -eq 0 -and ($orcaCleanup.Raw | ConvertFrom-Json).closed -eq $true) 'Orca-only cleanup succeeds'

    # Degraded mode and exact CWD matching.
    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'nomatch'
    $env:PI_BOTS_TEST_ORCA_MODE = 'nomatch'
    $degradedRoot = Join-Path $resolvedTestRoot 'records-degraded'
    $degraded = Invoke-TestPublisher -RecordRoot $degradedRoot
    Assert-True ($degraded.ExitCode -eq 0) 'optional surface failures do not fail publication'
    $degradedJson = $degraded.Raw | ConvertFrom-Json
    Assert-True ($degradedJson.hasExternalViews -eq $false) 'degraded mode reports no external views'
    Assert-True ($degradedJson.view.herdr.status -eq 'unavailable') 'Herdr no-match degrades without creating a tab'
    Assert-True ($degradedJson.view.orca.status -ne 'created') 'Orca no-match degrades without creating a tab'

    $env:PI_BOTS_TEST_HERDR_MODE = 'match'
    $env:PI_BOTS_TEST_ORCA_MODE = 'match'
    $addedLater = Invoke-TestPublisher -RecordRoot $degradedRoot -ExtraArguments @('-SyncMissing')
    $addedLaterJson = $addedLater.Raw | ConvertFrom-Json
    Assert-True ($addedLaterJson.view.herdr.status -eq 'created' -and $addedLaterJson.view.orca.status -eq 'created') 'sync adds surfaces that became available later'
    $addedAgain = Invoke-TestPublisher -RecordRoot $degradedRoot -ExtraArguments @('-SyncMissing')
    $laterHerdr = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    $laterOrca = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($laterHerdr.tabs).Count -eq 1 -and @($laterOrca.terminals).Count -eq 1) 'repeated sync keeps each late surface unique'
    Assert-True ((Invoke-TestCloser -RecordRoot $degradedRoot).ExitCode -eq 0) 'late surfaces retain exact cleanup identities'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'nomatch'
    $env:PI_BOTS_TEST_ORCA_MODE = 'match'
    $orcaSurvivesRoot = Join-Path $resolvedTestRoot 'records-orca-survives'
    $orcaSurvives = Invoke-TestPublisher -RecordRoot $orcaSurvivesRoot
    $orcaSurvivesJson = $orcaSurvives.Raw | ConvertFrom-Json
    Assert-True ($orcaSurvives.ExitCode -eq 0 -and $orcaSurvivesJson.view.herdr.status -eq 'unavailable') 'Herdr degradation does not fail publication'
    Assert-True ($orcaSurvivesJson.view.orca.status -eq 'created' -and $orcaSurvivesJson.hasExternalViews -eq $true) 'Orca remains active when Herdr is unavailable'
    Assert-True ((Invoke-TestCloser -RecordRoot $orcaSurvivesRoot).ExitCode -eq 0) 'surviving Orca view cleans up independently'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'match'
    $env:PI_BOTS_TEST_ORCA_MODE = 'nomatch'
    $herdrSurvivesRoot = Join-Path $resolvedTestRoot 'records-herdr-survives'
    $herdrSurvives = Invoke-TestPublisher -RecordRoot $herdrSurvivesRoot
    $herdrSurvivesJson = $herdrSurvives.Raw | ConvertFrom-Json
    Assert-True ($herdrSurvives.ExitCode -eq 0 -and $herdrSurvivesJson.view.orca.status -ne 'created') 'Orca degradation does not fail publication'
    Assert-True ($herdrSurvivesJson.view.herdr.status -eq 'created' -and $herdrSurvivesJson.hasExternalViews -eq $true) 'Herdr remains active when Orca is unavailable'
    Assert-True ((Invoke-TestCloser -RecordRoot $herdrSurvivesRoot).ExitCode -eq 0) 'surviving Herdr view cleans up independently'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'ambiguous'
    $ambiguousRoot = Join-Path $resolvedTestRoot 'records-ambiguous'
    $ambiguous = Invoke-TestPublisher -RecordRoot $ambiguousRoot -ExtraArguments @('-NoOrca')
    $ambiguousJson = $ambiguous.Raw | ConvertFrom-Json
    Assert-True ($ambiguous.ExitCode -eq 0 -and $ambiguousJson.view.herdr.status -eq 'unavailable') 'ambiguous Herdr CWD matches are skipped safely'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 0) 'ambiguous Herdr matching creates no tab'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'runfail'
    $rollbackRoot = Join-Path $resolvedTestRoot 'records-rollback'
    $rollback = Invoke-TestPublisher -RecordRoot $rollbackRoot -ExtraArguments @('-NoOrca')
    $rollbackJson = $rollback.Raw | ConvertFrom-Json
    Assert-True ($rollback.ExitCode -eq 0 -and $rollbackJson.view.herdr.status -eq 'failed') 'Herdr watcher-start failure degrades without failing the run'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 0) 'failed Herdr watcher creation rolls its tab back'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'badlink'
    $badLinkRoot = Join-Path $resolvedTestRoot 'records-bad-herdr-link'
    $badLink = Invoke-TestPublisher -RecordRoot $badLinkRoot -ExtraArguments @('-NoOrca')
    $badLinkJson = $badLink.Raw | ConvertFrom-Json
    Assert-True ($badLink.ExitCode -eq 0 -and $badLinkJson.view.herdr.status -eq 'failed') 'mismatched Herdr response identities are rejected'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 0) 'mismatched Herdr identity rolls back the exact new tab'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'missingids'
    $missingIdsRoot = Join-Path $resolvedTestRoot 'records-missing-herdr-ids'
    $missingIds = Invoke-TestPublisher -RecordRoot $missingIdsRoot -ExtraArguments @('-NoOrca')
    $missingIdsJson = $missingIds.Raw | ConvertFrom-Json
    Assert-True ($missingIds.ExitCode -eq 0 -and $missingIdsJson.view.herdr.status -eq 'failed') 'missing Herdr response identities are rejected'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 0) 'missing Herdr identity is recovered by creation delta and rolled back'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'missingidsuntagged'
    $untrackedHerdrRoot = Join-Path $resolvedTestRoot 'records-untracked-herdr'
    $untrackedHerdr = Invoke-TestPublisher -RecordRoot $untrackedHerdrRoot -ExtraArguments @('-NoOrca')
    $untrackedHerdrJson = $untrackedHerdr.Raw | ConvertFrom-Json
    Assert-True ($untrackedHerdr.ExitCode -eq 0 -and $untrackedHerdrJson.view.herdr.possibleUntrackedTab -eq $true) 'unrecoverable Herdr identity is flagged for manual verification'
    Assert-True ($untrackedHerdrJson.hasExternalViews -eq $true) 'possible untracked Herdr view is never hidden from cleanup policy'
    $untrackedHerdrPreflight = Invoke-TestCloser -RecordRoot $untrackedHerdrRoot -PreflightOnly
    Assert-True ($untrackedHerdrPreflight.ExitCode -eq 2 -and ($untrackedHerdrPreflight.Raw | ConvertFrom-Json).safeToClose -eq $false) 'cleanup never guesses an unrecoverable Herdr identity'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'createexit'
    $herdrCreateExitRoot = Join-Path $resolvedTestRoot 'records-herdr-create-exit'
    $herdrCreateExit = Invoke-TestPublisher -RecordRoot $herdrCreateExitRoot -ExtraArguments @('-NoOrca')
    $herdrCreateExitJson = $herdrCreateExit.Raw | ConvertFrom-Json
    Assert-True ($herdrCreateExit.ExitCode -eq 0 -and $herdrCreateExitJson.view.herdr.status -eq 'failed') 'Herdr command failure after mutation is reconciled'
    $herdrState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_HERDR_STATE | ConvertFrom-Json
    Assert-True (@($herdrState.tabs).Count -eq 0) 'post-create Herdr command failure rolls back the exact creation delta'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'badlinkclosefail'
    $trackedRollbackRoot = Join-Path $resolvedTestRoot 'records-tracked-rollback'
    $trackedRollback = Invoke-TestPublisher -RecordRoot $trackedRollbackRoot -ExtraArguments @('-NoOrca')
    $trackedRollbackJson = $trackedRollback.Raw | ConvertFrom-Json
    Assert-True ($trackedRollback.ExitCode -eq 0 -and $trackedRollbackJson.view.herdr.status -eq 'created') 'failed Herdr rollback retains the exact tab as created'
    Assert-True ($trackedRollbackJson.hasExternalViews -eq $true -and -not [string]::IsNullOrWhiteSpace($trackedRollbackJson.view.herdr.tabId)) 'failed rollback remains tracked for cleanup'
    $trackedPreflight = Invoke-TestCloser -RecordRoot $trackedRollbackRoot -PreflightOnly
    Assert-True ($trackedPreflight.ExitCode -eq 0 -and ($trackedPreflight.Raw | ConvertFrom-Json).cleanupNeeded -eq $true) 'tracked rollback failure still requests cleanup'
    $env:PI_BOTS_TEST_HERDR_MODE = 'match'
    Assert-True ((Invoke-TestCloser -RecordRoot $trackedRollbackRoot).ExitCode -eq 0) 'tracked rollback failure cleans up later by exact ID'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_ORCA_MODE = 'badidentity'
    $badOrcaRoot = Join-Path $resolvedTestRoot 'records-bad-orca-identity'
    $badOrca = Invoke-TestPublisher -RecordRoot $badOrcaRoot -ExtraArguments @('-NoHerdr')
    $badOrcaJson = $badOrca.Raw | ConvertFrom-Json
    Assert-True ($badOrca.ExitCode -eq 0 -and $badOrcaJson.view.orca.status -eq 'failed') 'mismatched Orca response identities are rejected'
    $orcaState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($orcaState.terminals).Count -eq 0) 'mismatched Orca identity rolls back the exact new terminal'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_ORCA_MODE = 'missingidsuntagged'
    $untrackedOrcaRoot = Join-Path $resolvedTestRoot 'records-untracked-orca'
    $untrackedOrca = Invoke-TestPublisher -RecordRoot $untrackedOrcaRoot -ExtraArguments @('-NoHerdr')
    $untrackedOrcaJson = $untrackedOrca.Raw | ConvertFrom-Json
    Assert-True ($untrackedOrca.ExitCode -eq 0 -and $untrackedOrcaJson.view.orca.possibleUntrackedTab -eq $true) 'unrecoverable Orca identity is flagged for manual verification'
    Assert-True ($untrackedOrcaJson.hasExternalViews -eq $true) 'possible untracked Orca view is never hidden from cleanup policy'
    $untrackedOrcaPreflight = Invoke-TestCloser -RecordRoot $untrackedOrcaRoot -PreflightOnly
    Assert-True ($untrackedOrcaPreflight.ExitCode -eq 2 -and ($untrackedOrcaPreflight.Raw | ConvertFrom-Json).safeToClose -eq $false) 'cleanup never guesses an unrecoverable Orca identity'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_ORCA_MODE = 'createexit'
    $orcaCreateExitRoot = Join-Path $resolvedTestRoot 'records-orca-create-exit'
    $orcaCreateExit = Invoke-TestPublisher -RecordRoot $orcaCreateExitRoot -ExtraArguments @('-NoHerdr')
    $orcaCreateExitJson = $orcaCreateExit.Raw | ConvertFrom-Json
    Assert-True ($orcaCreateExit.ExitCode -eq 0 -and $orcaCreateExitJson.view.orca.status -eq 'failed') 'Orca command failure after mutation is reconciled'
    $orcaState = Get-Content -Raw -LiteralPath $env:PI_BOTS_TEST_ORCA_STATE | ConvertFrom-Json
    Assert-True (@($orcaState.terminals).Count -eq 0) 'post-create Orca command failure rolls back the exact creation delta'

    # Enumeration failures remain fail-closed during cleanup.
    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'match'
    $env:PI_BOTS_TEST_ORCA_MODE = 'match'
    $failureRoot = Join-Path $resolvedTestRoot 'records-failure'
    $failurePublish = Invoke-TestPublisher -RecordRoot $failureRoot
    Assert-True ($failurePublish.ExitCode -eq 0 -and ($failurePublish.Raw | ConvertFrom-Json).hasExternalViews -eq $true) 'cleanup failure fixture publishes views'
    $env:PI_BOTS_TEST_ORCA_LIST_FAIL = '1'
    $failedPreflight = Invoke-TestCloser -RecordRoot $failureRoot -PreflightOnly
    Assert-True ($failedPreflight.ExitCode -eq 2) 'cleanup refuses an Orca enumeration failure'
    Assert-True (($failedPreflight.Raw | ConvertFrom-Json).safeToClose -eq $false) 'enumeration failure is fail-closed'
    Remove-Item Env:PI_BOTS_TEST_ORCA_LIST_FAIL -ErrorAction SilentlyContinue
    $finalCleanup = Invoke-TestCloser -RecordRoot $failureRoot
    Assert-True ($finalCleanup.ExitCode -eq 0) 'failure fixture can be cleaned after recovery'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'match'
    $herdrFailureRoot = Join-Path $resolvedTestRoot 'records-herdr-list-failure'
    $herdrFailurePublish = Invoke-TestPublisher -RecordRoot $herdrFailureRoot -ExtraArguments @('-NoOrca')
    Assert-True ($herdrFailurePublish.ExitCode -eq 0 -and ($herdrFailurePublish.Raw | ConvertFrom-Json).hasExternalViews -eq $true) 'Herdr cleanup failure fixture publishes a view'
    $env:PI_BOTS_TEST_HERDR_LIST_FAIL = '1'
    $herdrFailedPreflight = Invoke-TestCloser -RecordRoot $herdrFailureRoot -PreflightOnly
    Assert-True ($herdrFailedPreflight.ExitCode -eq 2) 'cleanup refuses a Herdr enumeration failure'
    Assert-True (($herdrFailedPreflight.Raw | ConvertFrom-Json).safeToClose -eq $false) 'Herdr enumeration failure is fail-closed'
    Remove-Item Env:PI_BOTS_TEST_HERDR_LIST_FAIL -ErrorAction SilentlyContinue
    Assert-True ((Invoke-TestCloser -RecordRoot $herdrFailureRoot).ExitCode -eq 0) 'Herdr failure fixture can be cleaned after recovery'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_HERDR_MODE = 'match'
    $herdrCloseFailureRoot = Join-Path $resolvedTestRoot 'records-herdr-close-failure'
    $herdrCloseFailurePublish = Invoke-TestPublisher -RecordRoot $herdrCloseFailureRoot -ExtraArguments @('-NoOrca')
    Assert-True ($herdrCloseFailurePublish.ExitCode -eq 0) 'Herdr close-failure fixture publishes a view'
    $env:PI_BOTS_TEST_HERDR_CLOSE_FAIL = '1'
    $herdrCloseFailure = Invoke-TestCloser -RecordRoot $herdrCloseFailureRoot
    $herdrCloseFailureJson = $herdrCloseFailure.Raw | ConvertFrom-Json
    Assert-True ($herdrCloseFailure.ExitCode -eq 3 -and $herdrCloseFailureJson.closed -eq $false) 'Herdr close failure is reported'
    Assert-True ($herdrCloseFailureJson.cleanupNeeded -eq $true -and $herdrCloseFailureJson.safeToClose -eq $false) 'failed Herdr close remains eligible for a safe retry'
    Remove-Item Env:PI_BOTS_TEST_HERDR_CLOSE_FAIL -ErrorAction SilentlyContinue
    Assert-True ((Invoke-TestCloser -RecordRoot $herdrCloseFailureRoot).ExitCode -eq 0) 'Herdr close succeeds after recovery'

    Reset-SurfaceState
    $env:PI_BOTS_TEST_ORCA_MODE = 'match'
    $orcaCloseFailureRoot = Join-Path $resolvedTestRoot 'records-orca-close-failure'
    $orcaCloseFailurePublish = Invoke-TestPublisher -RecordRoot $orcaCloseFailureRoot -ExtraArguments @('-NoHerdr')
    Assert-True ($orcaCloseFailurePublish.ExitCode -eq 0) 'Orca close-failure fixture publishes a view'
    $env:PI_BOTS_TEST_ORCA_CLOSE_FAIL = '1'
    $orcaCloseFailure = Invoke-TestCloser -RecordRoot $orcaCloseFailureRoot
    $orcaCloseFailureJson = $orcaCloseFailure.Raw | ConvertFrom-Json
    Assert-True ($orcaCloseFailure.ExitCode -eq 3 -and $orcaCloseFailureJson.closed -eq $false) 'Orca close failure is reported'
    Assert-True ($orcaCloseFailureJson.cleanupNeeded -eq $true -and $orcaCloseFailureJson.safeToClose -eq $false) 'failed Orca close remains eligible for a safe retry'
    Remove-Item Env:PI_BOTS_TEST_ORCA_CLOSE_FAIL -ErrorAction SilentlyContinue
    Assert-True ((Invoke-TestCloser -RecordRoot $orcaCloseFailureRoot).ExitCode -eq 0) 'Orca close succeeds after recovery'

    $writeResidue = @(Get-ChildItem -LiteralPath $resolvedTestRoot -Recurse -File | Where-Object { $_.Name -match '\.(?:tmp|bak)$' })
    Assert-True ($writeResidue.Count -eq 0) 'atomic record updates leave no temporary or backup residue'
    Write-Output 'ALL TESTS PASSED'
}
finally {
    foreach ($name in @(
        'PI_BOTS_TEST_HERDR_STATE', 'PI_BOTS_TEST_ORCA_STATE', 'PI_BOTS_TEST_PROJECT_DIR',
        'PI_BOTS_TEST_HERDR_MODE', 'PI_BOTS_TEST_ORCA_MODE', 'PI_BOTS_TEST_HERDR_LIST_FAIL',
        'PI_BOTS_TEST_ORCA_LIST_FAIL', 'PI_BOTS_TEST_HERDR_CLOSE_FAIL', 'PI_BOTS_TEST_ORCA_CLOSE_FAIL',
        'PI_BOTS_TEST_CREATE_DELAY_MS'
    )) {
        Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $resolvedTestRoot -PathType Container) {
        $resolvedAgain = (Resolve-Path -LiteralPath $resolvedTestRoot).Path
        if ($resolvedAgain.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
            ([System.IO.Path]::GetFileName($resolvedAgain)).StartsWith('pi-bots-test-')) {
            Remove-Item -LiteralPath $resolvedAgain -Recurse -Force
        }
    }
}
