[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string]$RunId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AsyncDir,

    [Parameter(Mandatory = $true)]
    [ValidateRange(0, 100000)]
    [int]$ChildIndex,

    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 100)]
    [string]$Title,

    [switch]$NoHerdr,
    [switch]$NoOrca,
    [switch]$SyncMissing,
    [string]$HerdrExecutable = '',
    [string]$OrcaExecutable = '',
    [string]$RecordRoot = '',
    [ValidateRange(0, 100000)]
    [int]$WatcherMaxRefreshes = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Get-OptionalProperty {
    param([AllowNull()][object]$InputObject, [Parameter(Mandatory = $true)][string]$Name)
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) { return $InputObject[$Name] }
        return $null
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function ConvertTo-Hashtable {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in $Value.Keys) { $result[$key] = ConvertTo-Hashtable $Value[$key] }
        return $result
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $result = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) { $result[$property.Name] = ConvertTo-Hashtable $property.Value }
        return $result
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        $items = @()
        foreach ($item in $Value) { $items += ,(ConvertTo-Hashtable $item) }
        return ,$items
    }
    return $Value
}

function Resolve-Executable {
    param([string]$Explicit, [string]$Name, [string]$Fallback)
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        if (Test-Path -LiteralPath $Explicit -PathType Leaf) { return (Resolve-Path -LiteralPath $Explicit).Path }
        return $null
    }
    if (-not [string]::IsNullOrWhiteSpace($Fallback) -and (Test-Path -LiteralPath $Fallback -PathType Leaf)) { return (Resolve-Path -LiteralPath $Fallback).Path }
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) { return $command.Source }
    return $null
}

function Invoke-JsonCommand {
    param([Parameter(Mandatory = $true)][string]$Executable, [Parameter(Mandatory = $true)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = (& $Executable @Arguments 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) { throw "$Executable $($Arguments -join ' ') failed ($exitCode):`n$raw" }
    try { return $raw | ConvertFrom-Json }
    catch { throw "$Executable returned invalid JSON for '$($Arguments -join ' ')':`n$raw" }
}

function Assert-OrcaSuccess {
    param([Parameter(Mandatory = $true)][object]$Response, [Parameter(Mandatory = $true)][string]$Operation)
    if ((Get-OptionalProperty $Response 'ok') -ne $true) {
        throw "Orca operation failed: $Operation"
    }
}

function ConvertTo-PowerShellLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Write-JsonFile {
    param([Parameter(Mandatory = $true)][object]$Value, [Parameter(Mandatory = $true)][string]$Path)
    $json = $Value | ConvertTo-Json -Depth 30
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $temporaryPath = "$Path.$PID.tmp"
    [System.IO.File]::WriteAllText($temporaryPath, $json, $encoding)
    if (Test-Path -LiteralPath $Path) {
        $backupPath = "$Path.$PID.bak"
        if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
        [System.IO.File]::Replace($temporaryPath, $Path, $backupPath)
        if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
    }
    else { [System.IO.File]::Move($temporaryPath, $Path) }
}

function Enter-FileClaim {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateRange(100, 120000)][int]$TimeoutMilliseconds = 30000
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ($true) {
        try {
            $stream = [System.IO.File]::Open(
                $Path,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
            $stream.SetLength(0)
            $payload = [System.Text.Encoding]::UTF8.GetBytes("pid=$PID acquired=$([DateTime]::UtcNow.ToString('o'))")
            $stream.Write($payload, 0, $payload.Length)
            $stream.Flush()
            return $stream
        }
        catch [System.UnauthorizedAccessException] { throw }
        catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for the Pi Bots publication claim: $Path" }
            Start-Sleep -Milliseconds 100
        }
    }
}

function Get-CanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $full = [System.IO.Path]::GetFullPath($Path)
        $root = [System.IO.Path]::GetPathRoot($full)
        if ($full.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { return $root }
        return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    }
    catch { return $null }
}

function Test-SamePath {
    param([string]$Left, [string]$Right)
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    $leftPath = Get-CanonicalPath $Left
    $rightPath = Get-CanonicalPath $Right
    if ($null -eq $leftPath -or $null -eq $rightPath) { return $false }
    return $leftPath.Equals($rightPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-HerdrTabsStrict {
    param([Parameter(Mandatory = $true)][string]$Executable, [Parameter(Mandatory = $true)][string]$WorkspaceId)
    $response = Invoke-JsonCommand -Executable $Executable -Arguments @('tab', 'list', '--workspace', $WorkspaceId)
    $result = Get-OptionalProperty $response 'result'
    if ([string](Get-OptionalProperty $result 'type') -ne 'tab_list') {
        throw "Herdr returned an unexpected tab-list response for workspace '$WorkspaceId'."
    }
    return @(Get-OptionalProperty $result 'tabs')
}

function Remove-HerdrTabExact {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$WorkspaceId,
        [Parameter(Mandatory = $true)][string]$TabId
    )
    $messages = @()
    try { [void](Invoke-JsonCommand -Executable $Executable -Arguments @('tab', 'close', $TabId)) }
    catch { $messages += $_.Exception.Message }
    try {
        $remaining = @(Get-HerdrTabsStrict -Executable $Executable -WorkspaceId $WorkspaceId | Where-Object {
            [string]::Equals([string](Get-OptionalProperty $_ 'tab_id'), $TabId, [System.StringComparison]::Ordinal)
        })
        if ($remaining.Count -eq 0) { return [pscustomobject]@{ ok = $true; error = '' } }
        $messages += "Herdr tab '$TabId' remained open."
    }
    catch { $messages += $_.Exception.Message }
    return [pscustomobject]@{ ok = $false; error = ($messages -join '; ') }
}

function Get-OrcaTerminalsStrict {
    param([Parameter(Mandatory = $true)][string]$Executable)
    $response = Invoke-JsonCommand -Executable $Executable -Arguments @('terminal', 'list', '--json')
    Assert-OrcaSuccess -Response $response -Operation 'terminal list'
    return @(Get-OptionalProperty (Get-OptionalProperty $response 'result') 'terminals')
}

function Remove-OrcaTerminalExact {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$Handle,
        [Parameter(Mandatory = $true)][string]$TabId
    )
    $messages = @()
    try {
        $response = Invoke-JsonCommand -Executable $Executable -Arguments @('terminal', 'close', '--terminal', $Handle, '--tab', '--json')
        Assert-OrcaSuccess -Response $response -Operation 'terminal close'
    }
    catch { $messages += $_.Exception.Message }
    try {
        $remaining = @(Get-OrcaTerminalsStrict -Executable $Executable | Where-Object {
            [string]::Equals([string](Get-OptionalProperty $_ 'handle'), $Handle, [System.StringComparison]::Ordinal) -or
                [string]::Equals([string](Get-OptionalProperty $_ 'tabId'), $TabId, [System.StringComparison]::Ordinal)
        })
        if ($remaining.Count -eq 0) { return [pscustomobject]@{ ok = $true; error = '' } }
        $messages += "Orca terminal '$Handle' / tab '$TabId' remained open."
    }
    catch { $messages += $_.Exception.Message }
    return [pscustomobject]@{ ok = $false; error = ($messages -join '; ') }
}

function Test-SurfaceMayExist {
    param([Parameter(Mandatory = $true)][object]$Surface)
    return ([string](Get-OptionalProperty $Surface 'status') -eq 'created' -or
        [bool](Get-OptionalProperty $Surface 'possibleUntrackedTab'))
}

function Get-SurfaceSummary {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][object]$Surface)
    $status = [string](Get-OptionalProperty $Surface 'status')
    $reason = [string](Get-OptionalProperty $Surface 'reason')
    switch ($status) {
        'created' { if ($reason) { return "$Name aktiv ($reason)" }; return "$Name aktiv" }
        'skipped' { return "$Name übersprungen" }
        'unavailable' { if ($reason) { return "$Name übersprungen ($reason)" }; return "$Name übersprungen" }
        'failed' { if ($reason) { return "$Name fehlgeschlagen ($reason)" }; return "$Name fehlgeschlagen" }
        default { return "$Name $status" }
    }
}

if (-not [System.IO.Path]::IsPathRooted($AsyncDir) -or -not (Test-Path -LiteralPath $AsyncDir -PathType Container)) {
    throw "Async run directory is relative or does not exist: $AsyncDir"
}
$resolvedAsyncDir = (Resolve-Path -LiteralPath $AsyncDir).Path
$statusPath = Join-Path $resolvedAsyncDir 'status.json'
if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { throw "Subagent status does not exist: $statusPath" }
$status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
if ([string](Get-OptionalProperty $status 'runId') -cne $RunId) { throw 'RunId does not match status.json.' }
$steps = @(Get-OptionalProperty $status 'steps')
if ($ChildIndex -ge $steps.Count) { throw "Child index $ChildIndex is outside the status step list." }
$step = $steps[$ChildIndex]
$agent = [string](Get-OptionalProperty $step 'agent')
if ([string]::IsNullOrWhiteSpace($agent)) { $agent = 'pi-bot' }
$outputPath = Join-Path $resolvedAsyncDir "output-$ChildIndex.log"

$runCwd = [string](Get-OptionalProperty $status 'cwd')
if ([string]::IsNullOrWhiteSpace($runCwd) -or -not [System.IO.Path]::IsPathRooted($runCwd) -or
    -not (Test-Path -LiteralPath $runCwd -PathType Container)) {
    throw "The canonical subagent cwd is unavailable, relative, or not a directory: $runCwd"
}
$resolvedCwd = (Resolve-Path -LiteralPath $runCwd).Path

$cleanTitle = [regex]::Replace($Title.Trim(), '[\x00-\x1F\x7F]', '')
$cleanTitle = [regex]::Replace($cleanTitle, '\s+', ' ')
if ([string]::IsNullOrWhiteSpace($cleanTitle)) { throw 'Title must contain visible characters.' }
if ($cleanTitle.Length -gt 80) { $cleanTitle = $cleanTitle.Substring(0, 80).Trim() }
$viewToken = [guid]::NewGuid().ToString('N').Substring(0, 12)
$surfaceSuffix = " [pb-$viewToken]"
$surfaceBaseLength = 80 - $surfaceSuffix.Length
$surfaceTitle = $cleanTitle
if ($surfaceTitle.Length -gt $surfaceBaseLength) { $surfaceTitle = $surfaceTitle.Substring(0, $surfaceBaseLength).Trim() }
$surfaceTitle += $surfaceSuffix

if ([string]::IsNullOrWhiteSpace($RecordRoot)) {
    $RecordRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'pi-bots\runs'
}
$runDirectory = Join-Path $RecordRoot $RunId
$recordPath = Join-Path $runDirectory "child-$ChildIndex.json"
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

$claimPath = Join-Path $runDirectory '.publication.claim'
$recordClaim = Enter-FileClaim -Path $claimPath
try {
    $record = $null
    $existing = $null
    $resumingRecord = $false
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        $existing = ConvertTo-Hashtable (Get-Content -Raw -LiteralPath $recordPath | ConvertFrom-Json)
        if ([string](Get-OptionalProperty $existing 'runId') -cne $RunId -or
            [int](Get-OptionalProperty $existing 'childIndex') -ne $ChildIndex -or
            -not (Test-SamePath ([string](Get-OptionalProperty $existing 'asyncDir')) $resolvedAsyncDir) -or
            -not (Test-SamePath ([string](Get-OptionalProperty $existing 'cwd')) $resolvedCwd)) {
            throw "A different Pi Bots record already exists at $recordPath"
        }
        $existingHerdr = Get-OptionalProperty $existing 'herdr'
        $existingOrca = Get-OptionalProperty $existing 'orca'
        $freshSurfaces = @()
        if ($SyncMissing) {
            foreach ($surfaceName in @('herdr', 'orca')) {
                $surface = Get-OptionalProperty $existing $surfaceName
                $wanted = ($surfaceName -eq 'herdr' -and -not $NoHerdr) -or ($surfaceName -eq 'orca' -and -not $NoOrca)
                $neverCreated = [string](Get-OptionalProperty $surface 'status') -in @('skipped', 'unavailable') -or
                    ([string](Get-OptionalProperty $surface 'status') -eq 'failed' -and (Get-OptionalProperty $surface 'creationAttempted') -eq $false)
                if ($wanted -and $neverCreated -and -not (Test-SurfaceMayExist $surface)) {
                    $surface.requested = $true
                    $surface.status = 'pending'
                    $freshSurfaces += $surfaceName
                }
            }
            # Persist before invoking an external mutation. A crash from this point
            # must use token reconciliation, even for a newly available surface.
            Write-JsonFile -Value $existing -Path $recordPath
        }
        $herdrPending = [bool](Get-OptionalProperty $existingHerdr 'requested') -and [string](Get-OptionalProperty $existingHerdr 'status') -eq 'pending'
        $orcaPending = [bool](Get-OptionalProperty $existingOrca 'requested') -and [string](Get-OptionalProperty $existingOrca 'status') -eq 'pending'
        if (-not $herdrPending -and -not $orcaPending) {
            $hasViews = (Test-SurfaceMayExist $existingHerdr) -or (Test-SurfaceMayExist $existingOrca)
            $summary = 'Pi Bots: FleetView aktiv · ' + (Get-SurfaceSummary 'Herdr' $existingHerdr) + ' · ' + (Get-SurfaceSummary 'Orca' $existingOrca)
            [pscustomobject]@{ ok = $true; reused = $true; reconciled = $false; recordPath = $recordPath; hasExternalViews = $hasViews; summary = $summary; view = $existing } | ConvertTo-Json -Depth 30
            return
        }

        $record = $existing
        $resumingRecord = $true
        $cleanTitle = [string](Get-OptionalProperty $record 'title')
        $surfaceTitle = [string](Get-OptionalProperty $record 'surfaceTitle')
        $viewToken = [string](Get-OptionalProperty $record 'viewToken')
        if ([string]::IsNullOrWhiteSpace($cleanTitle) -or [string]::IsNullOrWhiteSpace($surfaceTitle) -or [string]::IsNullOrWhiteSpace($viewToken)) {
            foreach ($surfaceName in @('herdr', 'orca')) {
                $surface = Get-OptionalProperty $record $surfaceName
                if ([bool](Get-OptionalProperty $surface 'requested') -and [string](Get-OptionalProperty $surface 'status') -eq 'pending') {
                    $surface.status = 'failed'
                    $surface.possibleUntrackedTab = $true
                    $surface.reason = 'Interrupted publication record lacks its run-owned recovery token; manual verification is required.'
                }
            }
            $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
            Write-JsonFile -Value $record -Path $recordPath
            $hasViews = (Test-SurfaceMayExist $record.herdr) -or (Test-SurfaceMayExist $record.orca)
            $summary = 'Pi Bots: FleetView aktiv · ' + (Get-SurfaceSummary 'Herdr' $record.herdr) + ' · ' + (Get-SurfaceSummary 'Orca' $record.orca)
            [pscustomobject]@{ ok = $true; reused = $true; reconciled = $true; recordPath = $recordPath; hasExternalViews = $hasViews; summary = $summary; view = $record } | ConvertTo-Json -Depth 30
            return
        }
    }
    else {
        $freshSurfaces = @()
        $record = [ordered]@{
            version = 2
            runId = $RunId
            childIndex = $ChildIndex
            agent = $agent
            title = $cleanTitle
            surfaceTitle = $surfaceTitle
            viewToken = $viewToken
            cwd = $resolvedCwd
            asyncDir = $resolvedAsyncDir
            statusPath = $statusPath
            outputPath = $outputPath
            createdAtUtc = [DateTime]::UtcNow.ToString('o')
            updatedAtUtc = [DateTime]::UtcNow.ToString('o')
            herdr = [ordered]@{ requested = -not [bool]$NoHerdr; status = if ($NoHerdr) { 'skipped' } else { 'pending' }; creationAttempted = $false }
            orca = [ordered]@{ requested = -not [bool]$NoOrca; status = if ($NoOrca) { 'skipped' } else { 'pending' }; creationAttempted = $false }
        }
        Write-JsonFile -Value $record -Path $recordPath
    }

$watcherPath = Join-Path $PSScriptRoot 'Watch-PiBot.ps1'
$trustedPowerShell = ''
if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
    $candidatePowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $candidatePowerShell -PathType Leaf) { $trustedPowerShell = (Resolve-Path -LiteralPath $candidatePowerShell).Path }
}
$watcherUnavailableReason = ''
if (-not (Test-Path -LiteralPath $watcherPath -PathType Leaf)) { $watcherUnavailableReason = "Watcher script does not exist: $watcherPath" }
elseif ([string]::IsNullOrWhiteSpace($trustedPowerShell)) { $watcherUnavailableReason = 'Trusted Windows PowerShell 5.1 executable was not found under SystemRoot.' }
$watcherAvailable = [string]::IsNullOrWhiteSpace($watcherUnavailableReason)
$viewerCommand = ''
if ($watcherAvailable) {
    $watcherParts = @(
        '&', (ConvertTo-PowerShellLiteral $watcherPath),
        '-RunId', (ConvertTo-PowerShellLiteral $RunId),
        '-AsyncDir', (ConvertTo-PowerShellLiteral $resolvedAsyncDir),
        '-ChildIndex', [string]$ChildIndex,
        '-Title', (ConvertTo-PowerShellLiteral $cleanTitle)
    )
    if ($WatcherMaxRefreshes -gt 0) { $watcherParts += @('-MaxRefreshes', [string]$WatcherMaxRefreshes) }
    $watcherInvocation = $watcherParts -join ' '
    $encodedInvocation = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($watcherInvocation))
    $viewerCommand = "& $(ConvertTo-PowerShellLiteral $trustedPowerShell) -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedInvocation"
}

if ([bool]$record.herdr.requested -and [string]$record.herdr.status -eq 'pending') {
    $resumingRecord = [bool]$existing -and -not ($freshSurfaces -contains 'herdr')
    if (-not $watcherAvailable -and -not $resumingRecord) {
        $record.herdr.status = 'failed'
        $record.herdr.reason = $watcherUnavailableReason
    }
    else {
        $herdrFallback = Join-Path $env:LOCALAPPDATA 'Programs\Herdr\bin\herdr.exe'
        $herdr = Resolve-Executable -Explicit $HerdrExecutable -Name 'herdr' -Fallback $herdrFallback
        if ([string]::IsNullOrWhiteSpace($herdr)) {
            $record.herdr.status = 'unavailable'
            $record.herdr.reason = 'Herdr executable was not found.'
            if ($resumingRecord) {
                $record.herdr.possibleUntrackedTab = $true
                $record.herdr.reason = 'Interrupted Herdr publication cannot be reconciled because the executable is unavailable; manual verification is required.'
            }
        }
        else {
            try {
                $workspaceResponse = Invoke-JsonCommand -Executable $herdr -Arguments @('workspace', 'list')
                $workspaceResult = Get-OptionalProperty $workspaceResponse 'result'
                if ([string](Get-OptionalProperty $workspaceResult 'type') -ne 'workspace_list') { throw 'Herdr returned an unexpected workspace-list response.' }
                $matches = @()
                foreach ($workspace in @(Get-OptionalProperty $workspaceResult 'workspaces')) {
                    $worktree = Get-OptionalProperty $workspace 'worktree'
                    $checkoutPath = [string](Get-OptionalProperty $worktree 'checkout_path')
                    if (Test-SamePath $checkoutPath $resolvedCwd) { $matches += ,$workspace }
                }
                if ($matches.Count -eq 0) {
                    $record.herdr.status = 'unavailable'
                    $record.herdr.reason = 'no workspace exactly matches the run cwd'
                    if ($resumingRecord) {
                        $record.herdr.possibleUntrackedTab = $true
                        $record.herdr.reason += '; interrupted publication therefore requires manual verification'
                    }
                }
                elseif ($matches.Count -gt 1) {
                    $record.herdr.status = 'unavailable'
                    $record.herdr.reason = "$($matches.Count) workspaces exactly match the run cwd"
                    if ($resumingRecord) {
                        $record.herdr.possibleUntrackedTab = $true
                        $record.herdr.reason += '; interrupted publication therefore requires manual verification'
                    }
                }
                else {
                    $workspaceId = [string](Get-OptionalProperty $matches[0] 'workspace_id')
                    if ([string]::IsNullOrWhiteSpace($workspaceId)) { throw 'Matched Herdr workspace has no workspace_id.' }

                    $tabsBefore = @(Get-HerdrTabsStrict -Executable $herdr -WorkspaceId $workspaceId)
                    $beforeTabIds = @()
                    foreach ($existingTab in $tabsBefore) {
                        $existingTabId = [string](Get-OptionalProperty $existingTab 'tab_id')
                        if (-not [string]::IsNullOrWhiteSpace($existingTabId)) { $beforeTabIds += $existingTabId }
                    }
                    $ownedExistingTabs = @($tabsBefore | Where-Object {
                        [string]::Equals([string](Get-OptionalProperty $_ 'label'), $surfaceTitle, [System.StringComparison]::Ordinal)
                    })

                    if ($ownedExistingTabs.Count -eq 1) {
                        $recoveredTabId = [string](Get-OptionalProperty $ownedExistingTabs[0] 'tab_id')
                        if ([string]::IsNullOrWhiteSpace($recoveredTabId)) {
                            $record.herdr.status = 'failed'
                            $record.herdr.possibleUntrackedTab = $true
                            $record.herdr.reason = 'A run-token-matched Herdr tab lacks an exact tab ID; manual verification is required.'
                        }
                        else {
                            $record.herdr.status = 'created'
                            $record.herdr.workspaceId = $workspaceId
                            $record.herdr.tabId = $recoveredTabId
                            $record.herdr.watcherState = 'unknown-after-recovery'
                            $record.herdr.reason = 'Recovered an interrupted publication by its unique run-owned surface token.'
                        }
                        $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                        Write-JsonFile -Value $record -Path $recordPath
                    }
                    elseif ($ownedExistingTabs.Count -gt 1) {
                        $record.herdr.status = 'failed'
                        $record.herdr.possibleUntrackedTab = $true
                        $record.herdr.reason = "$($ownedExistingTabs.Count) Herdr tabs carry this run-owned surface token; manual verification is required."
                        $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                        Write-JsonFile -Value $record -Path $recordPath
                    }
                    else {
                    if ($resumingRecord) {
                        $record.herdr.status = 'failed'
                        $record.herdr.possibleUntrackedTab = $true
                        $record.herdr.reason = 'Interrupted Herdr publication has no uniquely token-matched tab; automatic recreation is refused to prevent duplicates.'
                        $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                        Write-JsonFile -Value $record -Path $recordPath
                    }
                    elseif (-not $watcherAvailable) {
                        $record.herdr.status = 'failed'
                        $record.herdr.reason = $watcherUnavailableReason
                        $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                        Write-JsonFile -Value $record -Path $recordPath
                    }
                    else {
                    $createResponse = $null
                    $createCommandError = ''
                    $record.herdr.creationAttempted = $true
                    Write-JsonFile -Value $record -Path $recordPath
                    try {
                        $createResponse = Invoke-JsonCommand -Executable $herdr -Arguments @(
                            'tab', 'create', '--workspace', $workspaceId, '--cwd', $resolvedCwd,
                            '--label', $surfaceTitle, '--no-focus'
                        )
                    }
                    catch { $createCommandError = $_.Exception.Message }
                    $createResult = Get-OptionalProperty $createResponse 'result'
                    $tab = Get-OptionalProperty $createResult 'tab'
                    $pane = Get-OptionalProperty $createResult 'root_pane'
                    $returnedTabId = [string](Get-OptionalProperty $tab 'tab_id')
                    $paneId = [string](Get-OptionalProperty $pane 'pane_id')
                    $validationErrors = @()
                    if (-not [string]::IsNullOrWhiteSpace($createCommandError)) {
                        $validationErrors += "Herdr tab-create command failed after dispatch: $createCommandError"
                    }
                    $tabsAfter = @()
                    $afterListSucceeded = $false
                    try {
                        $tabsAfter = @(Get-HerdrTabsStrict -Executable $herdr -WorkspaceId $workspaceId)
                        $afterListSucceeded = $true
                    }
                    catch { $validationErrors += $_.Exception.Message }

                    $allNewTabs = @()
                    $newTabs = @()
                    if ($afterListSucceeded) {
                        $allNewTabs = @($tabsAfter | Where-Object {
                            $candidateId = [string](Get-OptionalProperty $_ 'tab_id')
                            -not [string]::IsNullOrWhiteSpace($candidateId) -and -not ($beforeTabIds -ccontains $candidateId)
                        })
                        $newTabs = @($allNewTabs | Where-Object {
                            [string]::Equals([string](Get-OptionalProperty $_ 'label'), $surfaceTitle, [System.StringComparison]::Ordinal)
                        })
                    }

                    $tabId = ''
                    if (-not [string]::IsNullOrWhiteSpace($returnedTabId) -and -not ($beforeTabIds -ccontains $returnedTabId)) {
                        if (-not $afterListSucceeded -or @($tabsAfter | Where-Object {
                            [string]::Equals([string](Get-OptionalProperty $_ 'tab_id'), $returnedTabId, [System.StringComparison]::Ordinal)
                        }).Count -eq 1) {
                            $tabId = $returnedTabId
                        }
                    }
                    if ([string]::IsNullOrWhiteSpace($tabId) -and $newTabs.Count -eq 1) {
                        $tabId = [string](Get-OptionalProperty $newTabs[0] 'tab_id')
                    }

                    if ([string](Get-OptionalProperty $createResult 'type') -ne 'tab_created') {
                        $validationErrors += 'Herdr returned an unexpected tab-create response.'
                    }
                    if ([string]::IsNullOrWhiteSpace($returnedTabId)) { $validationErrors += 'Herdr tab-create response omitted tab_id.' }
                    if ([string]::IsNullOrWhiteSpace($paneId)) { $validationErrors += 'Herdr tab-create response omitted pane_id.' }
                    if ([string]::IsNullOrWhiteSpace($tabId)) { $validationErrors += 'The created Herdr tab could not be identified exactly.' }
                    if (-not [string]::IsNullOrWhiteSpace($returnedTabId) -and -not [string]::IsNullOrWhiteSpace($tabId) -and
                        -not [string]::Equals($returnedTabId, $tabId, [System.StringComparison]::Ordinal)) {
                        $validationErrors += 'Herdr returned a tab identity that does not match the newly created tab.'
                    }
                    if (-not [string]::Equals([string](Get-OptionalProperty $tab 'workspace_id'), $workspaceId, [System.StringComparison]::Ordinal)) {
                        $validationErrors += 'Herdr returned a tab linked to a different workspace.'
                    }
                    if (-not [string]::Equals([string](Get-OptionalProperty $pane 'workspace_id'), $workspaceId, [System.StringComparison]::Ordinal)) {
                        $validationErrors += 'Herdr returned a pane linked to a different workspace.'
                    }
                    if (-not [string]::Equals([string](Get-OptionalProperty $pane 'tab_id'), $returnedTabId, [System.StringComparison]::Ordinal)) {
                        $validationErrors += 'Herdr returned a pane linked to a different tab.'
                    }
                    if ($afterListSucceeded -and -not [string]::IsNullOrWhiteSpace($tabId) -and @($tabsAfter | Where-Object {
                        [string]::Equals([string](Get-OptionalProperty $_ 'tab_id'), $tabId, [System.StringComparison]::Ordinal)
                    }).Count -ne 1) {
                        $validationErrors += 'The created Herdr tab is not uniquely present in its matched workspace.'
                    }

                    $record.herdr.workspaceId = $workspaceId
                    if (-not [string]::IsNullOrWhiteSpace($tabId)) { $record.herdr.tabId = $tabId }
                    if (-not [string]::IsNullOrWhiteSpace($paneId)) { $record.herdr.paneId = $paneId }

                    if ($validationErrors.Count -gt 0) {
                        $identityError = $validationErrors -join '; '
                        if ([string]::IsNullOrWhiteSpace($tabId)) {
                            $record.herdr.status = 'failed'
                            if (-not $afterListSucceeded -or $allNewTabs.Count -gt 0) {
                                $record.herdr.possibleUntrackedTab = $true
                                $record.herdr.reason = "$identityError Manual Herdr verification is required because no exact tab ID was recoverable."
                            }
                            else { $record.herdr.reason = $identityError }
                        }
                        else {
                            $record.herdr.status = 'created'
                            $record.herdr.watcherState = 'not-started'
                            $record.herdr.reason = "invalid creation identity; exact-ID rollback pending: $identityError"
                            $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                            Write-JsonFile -Value $record -Path $recordPath
                            $rollback = Remove-HerdrTabExact -Executable $herdr -WorkspaceId $workspaceId -TabId $tabId
                            if ($rollback.ok) {
                                $record.herdr.status = 'failed'
                                $record.herdr.reason = "invalid creation identity; created tab was rolled back: $identityError"
                            }
                            else {
                                $record.herdr.status = 'created'
                                $record.herdr.reason = "invalid creation identity and rollback failed: $identityError; rollback: $($rollback.error)"
                            }
                        }
                        $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                        Write-JsonFile -Value $record -Path $recordPath
                    }
                    else {
                        $record.herdr.status = 'created'
                        $record.herdr.watcherState = 'starting'
                        $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                        Write-JsonFile -Value $record -Path $recordPath
                        try {
                            [void](Invoke-JsonCommand -Executable $herdr -Arguments @('pane', 'run', $paneId, $viewerCommand))
                            $record.herdr.watcherState = 'started'
                            if ($record.herdr.Contains('reason')) { $record.herdr.Remove('reason') }
                        }
                        catch {
                            $watchError = $_.Exception.Message
                            $record.herdr.watcherState = 'failed'
                            $rollback = Remove-HerdrTabExact -Executable $herdr -WorkspaceId $workspaceId -TabId $tabId
                            if ($rollback.ok) {
                                $record.herdr.status = 'failed'
                                $record.herdr.reason = "watcher failed; created tab was rolled back: $watchError"
                            }
                            else {
                                $record.herdr.status = 'created'
                                $record.herdr.reason = "watcher failed and created tab could not be rolled back: $watchError; rollback: $($rollback.error)"
                            }
                        }
                        $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                        Write-JsonFile -Value $record -Path $recordPath
                    }
                    }
                }
                }
            }
            catch {
                if ([string]$record.herdr.status -eq 'pending') { $record.herdr.status = 'failed' }
                $record.herdr.reason = $_.Exception.Message
                if ($resumingRecord) {
                    $record.herdr.possibleUntrackedTab = $true
                    $record.herdr.reason += '; interrupted publication could not be reconciled and requires manual verification'
                }
            }
        }
    }
}

if ([bool]$record.orca.requested -and [string]$record.orca.status -eq 'pending') {
    $resumingRecord = [bool]$existing -and -not ($freshSurfaces -contains 'orca')
    if (-not $watcherAvailable -and -not $resumingRecord) {
        $record.orca.status = 'failed'
        $record.orca.reason = $watcherUnavailableReason
    }
    else {
        $orcaFallback = Join-Path $env:LOCALAPPDATA 'Programs\orca\resources\bin\orca.exe'
        $orca = Resolve-Executable -Explicit $OrcaExecutable -Name 'orca' -Fallback $orcaFallback
        if ([string]::IsNullOrWhiteSpace($orca)) {
            $record.orca.status = 'unavailable'
            $record.orca.reason = 'Orca executable was not found.'
            if ($resumingRecord) {
                $record.orca.possibleUntrackedTab = $true
                $record.orca.reason = 'Interrupted Orca publication cannot be reconciled because the executable is unavailable; manual verification is required.'
            }
        }
        else {
            try {
                $worktreeResponse = Invoke-JsonCommand -Executable $orca -Arguments @('worktree', 'show', '--worktree', "path:$resolvedCwd", '--json')
                Assert-OrcaSuccess -Response $worktreeResponse -Operation 'worktree show'
                $worktree = Get-OptionalProperty (Get-OptionalProperty $worktreeResponse 'result') 'worktree'
                $worktreePath = [string](Get-OptionalProperty $worktree 'path')
                if (-not (Test-SamePath $worktreePath $resolvedCwd)) { throw 'Orca did not resolve the exact run cwd as a worktree.' }
                $terminalsBefore = @(Get-OrcaTerminalsStrict -Executable $orca)
                $beforeHandles = @()
                $beforeTabIds = @()
                foreach ($existingTerminal in $terminalsBefore) {
                    $existingHandle = [string](Get-OptionalProperty $existingTerminal 'handle')
                    $existingTabId = [string](Get-OptionalProperty $existingTerminal 'tabId')
                    if (-not [string]::IsNullOrWhiteSpace($existingHandle)) { $beforeHandles += $existingHandle }
                    if (-not [string]::IsNullOrWhiteSpace($existingTabId)) { $beforeTabIds += $existingTabId }
                }
                $ownedExistingTerminals = @($terminalsBefore | Where-Object {
                    [string]::Equals([string](Get-OptionalProperty $_ 'title'), $surfaceTitle, [System.StringComparison]::Ordinal)
                })

                if ($ownedExistingTerminals.Count -eq 1) {
                    $recoveredHandle = [string](Get-OptionalProperty $ownedExistingTerminals[0] 'handle')
                    $recoveredTabId = [string](Get-OptionalProperty $ownedExistingTerminals[0] 'tabId')
                    if ([string]::IsNullOrWhiteSpace($recoveredHandle) -or [string]::IsNullOrWhiteSpace($recoveredTabId)) {
                        $record.orca.status = 'failed'
                        $record.orca.possibleUntrackedTab = $true
                        $record.orca.reason = 'A run-token-matched Orca terminal lacks an exact handle or tab ID; manual verification is required.'
                    }
                    else {
                        $record.orca.status = 'created'
                        $record.orca.handle = $recoveredHandle
                        $record.orca.tabId = $recoveredTabId
                        $record.orca.surface = [string](Get-OptionalProperty $ownedExistingTerminals[0] 'surface')
                        $record.orca.watcherState = 'unknown-after-recovery'
                        $record.orca.reason = 'Recovered an interrupted publication by its unique run-owned surface token.'
                    }
                    $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                    Write-JsonFile -Value $record -Path $recordPath
                }
                elseif ($ownedExistingTerminals.Count -gt 1) {
                    $record.orca.status = 'failed'
                    $record.orca.possibleUntrackedTab = $true
                    $record.orca.reason = "$($ownedExistingTerminals.Count) Orca terminals carry this run-owned surface token; manual verification is required."
                    $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                    Write-JsonFile -Value $record -Path $recordPath
                }
                else {
                if ($resumingRecord) {
                    $record.orca.status = 'failed'
                    $record.orca.possibleUntrackedTab = $true
                    $record.orca.reason = 'Interrupted Orca publication has no uniquely token-matched terminal; automatic recreation is refused to prevent duplicates.'
                    $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                    Write-JsonFile -Value $record -Path $recordPath
                }
                elseif (-not $watcherAvailable) {
                    $record.orca.status = 'failed'
                    $record.orca.reason = $watcherUnavailableReason
                    $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                    Write-JsonFile -Value $record -Path $recordPath
                }
                else {
                $orcaResponse = $null
                $createCommandError = ''
                $record.orca.creationAttempted = $true
                Write-JsonFile -Value $record -Path $recordPath
                try {
                    $orcaResponse = Invoke-JsonCommand -Executable $orca -Arguments @(
                        'terminal', 'create', '--worktree', "path:$resolvedCwd",
                        '--title', $surfaceTitle, '--command', $viewerCommand, '--json'
                    )
                    Assert-OrcaSuccess -Response $orcaResponse -Operation 'terminal create'
                }
                catch { $createCommandError = $_.Exception.Message }
                $terminal = Get-OptionalProperty (Get-OptionalProperty $orcaResponse 'result') 'terminal'
                $returnedHandle = [string](Get-OptionalProperty $terminal 'handle')
                $returnedTabId = [string](Get-OptionalProperty $terminal 'tabId')
                $validationErrors = @()
                if (-not [string]::IsNullOrWhiteSpace($createCommandError)) {
                    $validationErrors += "Orca terminal-create command failed after dispatch: $createCommandError"
                }
                $terminalsAfter = @()
                $afterListSucceeded = $false
                try {
                    $terminalsAfter = @(Get-OrcaTerminalsStrict -Executable $orca)
                    $afterListSucceeded = $true
                }
                catch { $validationErrors += $_.Exception.Message }

                $allNewTerminals = @()
                $newTerminals = @()
                if ($afterListSucceeded) {
                    $allNewTerminals = @($terminalsAfter | Where-Object {
                        $candidateHandle = [string](Get-OptionalProperty $_ 'handle')
                        $candidateTabId = [string](Get-OptionalProperty $_ 'tabId')
                        -not [string]::IsNullOrWhiteSpace($candidateHandle) -and
                            -not [string]::IsNullOrWhiteSpace($candidateTabId) -and
                            -not ($beforeHandles -ccontains $candidateHandle) -and
                            -not ($beforeTabIds -ccontains $candidateTabId)
                    })
                    $newTerminals = @($allNewTerminals | Where-Object {
                        [string]::Equals([string](Get-OptionalProperty $_ 'title'), $surfaceTitle, [System.StringComparison]::Ordinal)
                    })
                }

                $createdTerminal = $null
                if (-not [string]::IsNullOrWhiteSpace($returnedHandle) -and
                    -not [string]::IsNullOrWhiteSpace($returnedTabId) -and
                    -not ($beforeHandles -ccontains $returnedHandle) -and
                    -not ($beforeTabIds -ccontains $returnedTabId)) {
                    if (-not $afterListSucceeded) {
                        $createdTerminal = $terminal
                    }
                    else {
                        $returnedMatches = @($terminalsAfter | Where-Object {
                            [string]::Equals([string](Get-OptionalProperty $_ 'handle'), $returnedHandle, [System.StringComparison]::Ordinal) -and
                                [string]::Equals([string](Get-OptionalProperty $_ 'tabId'), $returnedTabId, [System.StringComparison]::Ordinal)
                        })
                        if ($returnedMatches.Count -eq 1) { $createdTerminal = $returnedMatches[0] }
                    }
                }
                if ($null -eq $createdTerminal -and $newTerminals.Count -eq 1) { $createdTerminal = $newTerminals[0] }

                $handle = [string](Get-OptionalProperty $createdTerminal 'handle')
                $tabId = [string](Get-OptionalProperty $createdTerminal 'tabId')
                if ([string]::IsNullOrWhiteSpace($returnedHandle)) { $validationErrors += 'Orca terminal-create response omitted handle.' }
                if ([string]::IsNullOrWhiteSpace($returnedTabId)) { $validationErrors += 'Orca terminal-create response omitted tabId.' }
                if ([string]::IsNullOrWhiteSpace($handle) -or [string]::IsNullOrWhiteSpace($tabId)) {
                    $validationErrors += 'The created Orca terminal could not be identified exactly.'
                }
                if (-not [string]::IsNullOrWhiteSpace($returnedHandle) -and -not [string]::IsNullOrWhiteSpace($handle) -and
                    -not [string]::Equals($returnedHandle, $handle, [System.StringComparison]::Ordinal)) {
                    $validationErrors += 'Orca returned a handle that does not match the newly created terminal.'
                }
                if (-not [string]::IsNullOrWhiteSpace($returnedTabId) -and -not [string]::IsNullOrWhiteSpace($tabId) -and
                    -not [string]::Equals($returnedTabId, $tabId, [System.StringComparison]::Ordinal)) {
                    $validationErrors += 'Orca returned a tab identity that does not match the newly created terminal.'
                }
                if ($afterListSucceeded -and -not [string]::IsNullOrWhiteSpace($handle) -and -not [string]::IsNullOrWhiteSpace($tabId) -and
                    @($terminalsAfter | Where-Object {
                        [string]::Equals([string](Get-OptionalProperty $_ 'handle'), $handle, [System.StringComparison]::Ordinal) -and
                            [string]::Equals([string](Get-OptionalProperty $_ 'tabId'), $tabId, [System.StringComparison]::Ordinal)
                    }).Count -ne 1) {
                    $validationErrors += 'The created Orca terminal is not uniquely present.'
                }

                if (-not [string]::IsNullOrWhiteSpace($handle)) { $record.orca.handle = $handle }
                if (-not [string]::IsNullOrWhiteSpace($tabId)) { $record.orca.tabId = $tabId }
                $record.orca.surface = [string](Get-OptionalProperty $createdTerminal 'surface')

                if ($validationErrors.Count -gt 0) {
                    $identityError = $validationErrors -join '; '
                    if ([string]::IsNullOrWhiteSpace($handle) -or [string]::IsNullOrWhiteSpace($tabId)) {
                        $record.orca.status = 'failed'
                        if (-not $afterListSucceeded -or $allNewTerminals.Count -gt 0) {
                            $record.orca.possibleUntrackedTab = $true
                            $record.orca.reason = "$identityError Manual Orca verification is required because no exact terminal identity was recoverable."
                        }
                        else { $record.orca.reason = $identityError }
                    }
                    else {
                        $record.orca.status = 'created'
                        $record.orca.watcherState = 'unknown'
                        $record.orca.reason = "invalid creation identity; exact-ID rollback pending: $identityError"
                        $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                        Write-JsonFile -Value $record -Path $recordPath
                        $rollback = Remove-OrcaTerminalExact -Executable $orca -Handle $handle -TabId $tabId
                        if ($rollback.ok) {
                            $record.orca.status = 'failed'
                            $record.orca.reason = "invalid creation identity; created terminal was rolled back: $identityError"
                        }
                        else {
                            $record.orca.status = 'created'
                            $record.orca.reason = "invalid creation identity and rollback failed: $identityError; rollback: $($rollback.error)"
                        }
                    }
                }
                else {
                    $record.orca.status = 'created'
                    $record.orca.watcherState = 'started-by-terminal-create'
                    if ($record.orca.Contains('reason')) { $record.orca.Remove('reason') }
                }
                $record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
                Write-JsonFile -Value $record -Path $recordPath
                }
                }
            }
            catch {
                if ([string]$record.orca.status -eq 'pending') { $record.orca.status = 'failed' }
                $record.orca.reason = $_.Exception.Message
                if ($resumingRecord) {
                    $record.orca.possibleUntrackedTab = $true
                    $record.orca.reason += '; interrupted publication could not be reconciled and requires manual verification'
                }
            }
        }
    }
}

$record.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
Write-JsonFile -Value $record -Path $recordPath
$hasExternalViews = (Test-SurfaceMayExist $record.herdr) -or (Test-SurfaceMayExist $record.orca)
$summary = 'Pi Bots: FleetView aktiv · ' + (Get-SurfaceSummary 'Herdr' $record.herdr) + ' · ' + (Get-SurfaceSummary 'Orca' $record.orca)
$result = [ordered]@{
    ok = $true
    reused = $resumingRecord
    reconciled = $resumingRecord
    recordPath = $recordPath
    hasExternalViews = $hasExternalViews
    summary = $summary
    view = $record
}
[pscustomobject]$result | ConvertTo-Json -Depth 30
}
finally {
    if ($null -ne $recordClaim) { $recordClaim.Dispose() }
}
