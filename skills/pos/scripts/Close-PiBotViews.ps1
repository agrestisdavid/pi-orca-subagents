[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$RunId,

    [switch]$PreflightOnly,
    [string]$HerdrExecutable = '',
    [string]$OrcaExecutable = '',
    [string]$RecordRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

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

function Invoke-JsonCommand {
    param([Parameter(Mandatory = $true)][string]$Executable, [Parameter(Mandatory = $true)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = (& $Executable @Arguments 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) { return [ordered]@{ ok = $false; exitCode = $exitCode; raw = $raw; value = $null } }
    try { return [ordered]@{ ok = $true; exitCode = 0; raw = $raw; value = ConvertTo-Hashtable ($raw | ConvertFrom-Json) } }
    catch { return [ordered]@{ ok = $false; exitCode = 0; raw = $raw; value = $null; parseError = $_.Exception.Message } }
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
            return $stream
        }
        catch [System.UnauthorizedAccessException] { throw }
        catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for the Pi Bots run claim: $Path" }
            Start-Sleep -Milliseconds 100
        }
    }
}

function Get-HerdrTabs {
    param([Parameter(Mandatory = $true)][string]$Executable, [Parameter(Mandatory = $true)][string]$WorkspaceId)
    $response = Invoke-JsonCommand -Executable $Executable -Arguments @('tab', 'list', '--workspace', $WorkspaceId)
    if (-not $response.ok) { return [ordered]@{ ok = $false; error = "Could not list Herdr tabs for $WorkspaceId`: $($response.raw)"; tabs = @() } }
    $result = $response.value['result']
    if ($null -eq $result -or [string]$result['type'] -ne 'tab_list') {
        return [ordered]@{ ok = $false; error = "Herdr returned an unexpected tab-list response for $WorkspaceId."; tabs = @() }
    }
    return [ordered]@{ ok = $true; error = ''; tabs = @($result['tabs']) }
}

$RunId = $RunId.Trim()
if ($RunId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'RunId contains unsupported characters.' }
if ([string]::IsNullOrWhiteSpace($RecordRoot)) { $RecordRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'pi-bots\runs' }
$runDirectory = Join-Path $RecordRoot $RunId
if (-not (Test-Path -LiteralPath $runDirectory -PathType Container)) { throw "No Pi Bots visualization run exists at $runDirectory" }
$runClaim = Enter-FileClaim -Path (Join-Path $runDirectory '.publication.claim')
try {
$files = @(Get-ChildItem -LiteralPath $runDirectory -Filter '*.json' -File | Sort-Object Name)
if ($files.Count -eq 0) { throw "Pi Bots run '$RunId' has no view records." }

$entries = @()
$errors = @()
$needsHerdr = $false
$needsOrca = $false
$hasUntrackedExternalView = $false
$terminalStates = @('complete', 'completed', 'failed', 'partial', 'stopped', 'rejected')

foreach ($file in $files) {
    try { $record = ConvertTo-Hashtable (Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json) }
    catch { throw "Invalid Pi Bots record '$($file.FullName)': $($_.Exception.Message)" }
    if ([string]$record['runId'] -cne $RunId) { throw "Record '$($file.FullName)' belongs to a different run." }
    if ([int]$record['version'] -ne 2) { throw "Record '$($file.FullName)' uses unsupported version '$($record['version'])'." }

    $statusPath = [string]$record['statusPath']
    $lifecycle = 'unknown'
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
        $errors += "$($file.Name): status.json is missing."
    }
    else {
        try {
            $status = ConvertTo-Hashtable (Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json)
            if ([string]$status['runId'] -cne $RunId) { $errors += "$($file.Name): status run ID mismatch." }
            $index = [int]$record['childIndex']
            $steps = @($status['steps'])
            if ($index -ge $steps.Count) { $errors += "$($file.Name): child index is outside status steps." }
            else { $lifecycle = [string]$steps[$index]['status'] }
            if ($lifecycle -notin $terminalStates) { $errors += "$($file.Name): child state '$lifecycle' is not terminal." }
        }
        catch { $errors += "$($file.Name): status.json is invalid: $($_.Exception.Message)" }
    }

    $herdrState = 'not-created'
    if ([bool]$record['herdr']['requested'] -and [string]$record['herdr']['status'] -eq 'pending') {
        $hasUntrackedExternalView = $true
        $herdrState = 'publication-pending'
        $errors += "$($file.Name): Herdr publication is still pending or was interrupted; reconcile it before cleanup."
    }
    elseif ($record['herdr'].Contains('possibleUntrackedTab') -and [bool]$record['herdr']['possibleUntrackedTab']) {
        $hasUntrackedExternalView = $true
        $herdrState = 'identity-unknown'
        $errors += "$($file.Name): a Herdr tab may exist without a recoverable exact ID; manual verification is required."
    }
    elseif ([string]$record['herdr']['status'] -eq 'created') {
        $needsHerdr = $true
        $herdrState = 'pending-verification'
    }
    $orcaState = 'not-created'
    if ([bool]$record['orca']['requested'] -and [string]$record['orca']['status'] -eq 'pending') {
        $hasUntrackedExternalView = $true
        $orcaState = 'publication-pending'
        $errors += "$($file.Name): Orca publication is still pending or was interrupted; reconcile it before cleanup."
    }
    elseif ($record['orca'].Contains('possibleUntrackedTab') -and [bool]$record['orca']['possibleUntrackedTab']) {
        $hasUntrackedExternalView = $true
        $orcaState = 'identity-unknown'
        $errors += "$($file.Name): an Orca tab may exist without a recoverable exact identity; manual verification is required."
    }
    elseif ([string]$record['orca']['status'] -eq 'created') {
        $needsOrca = $true
        $orcaState = 'pending-verification'
    }
    $entries += [ordered]@{
        path = $file.FullName
        data = $record
        lifecycle = $lifecycle
        herdrState = $herdrState
        orcaState = $orcaState
    }
}

$herdrFallback = Join-Path $env:LOCALAPPDATA 'Programs\Herdr\bin\herdr.exe'
$orcaFallback = Join-Path $env:LOCALAPPDATA 'Programs\orca\resources\bin\orca.exe'
$herdr = if ($needsHerdr) { Resolve-Executable -Explicit $HerdrExecutable -Name 'herdr' -Fallback $herdrFallback } else { $null }
$orca = if ($needsOrca) { Resolve-Executable -Explicit $OrcaExecutable -Name 'orca' -Fallback $orcaFallback } else { $null }

if ($needsHerdr) {
    if ([string]::IsNullOrWhiteSpace($herdr)) { $errors += 'Herdr is unavailable, so created spectator tabs cannot be verified.' }
    else {
        foreach ($entry in $entries | Where-Object { $_.herdrState -eq 'pending-verification' }) {
            $workspaceId = [string]$entry.data['herdr']['workspaceId']
            $tabId = [string]$entry.data['herdr']['tabId']
            $listed = Get-HerdrTabs -Executable $herdr -WorkspaceId $workspaceId
            if (-not $listed.ok) {
                $entry.herdrState = 'verification-failed'
                $errors += "$($entry.data['agent']): $($listed.error)"
            }
            else {
                $matches = @($listed.tabs | Where-Object {
                    [string]::Equals([string]$_['tab_id'], $tabId, [System.StringComparison]::Ordinal)
                })
                if ($matches.Count -eq 0) {
                    $caseConflicts = @($listed.tabs | Where-Object {
                        [string]::Equals([string]$_['tab_id'], $tabId, [System.StringComparison]::OrdinalIgnoreCase)
                    })
                    if ($caseConflicts.Count -gt 0) {
                        $entry.herdrState = 'identity-error'
                        $errors += "$($entry.data['agent']): Herdr tab ID '$tabId' differs only by case from an existing tab."
                    }
                    else { $entry.herdrState = 'already-closed' }
                }
                elseif ($matches.Count -gt 1) { $entry.herdrState = 'identity-error'; $errors += "$($entry.data['agent']): Herdr tab ID '$tabId' is ambiguous." }
                else { $entry.herdrState = 'open' }
            }
        }
    }
}

$orcaTerminals = @()
if ($needsOrca) {
    if ([string]::IsNullOrWhiteSpace($orca)) { $errors += 'Orca is unavailable, so created spectator tabs cannot be verified.' }
    else {
        $list = Invoke-JsonCommand -Executable $orca -Arguments @('terminal', 'list', '--json')
        if (-not $list.ok -or $null -eq $list.value -or $list.value['ok'] -ne $true) {
            $errors += "Could not list Orca terminals: $($list.raw)"
        }
        else { $orcaTerminals = @($list.value['result']['terminals']) }
    }
}

if ($needsOrca -and -not [string]::IsNullOrWhiteSpace($orca) -and $errors.Count -eq 0) {
    foreach ($entry in $entries | Where-Object { $_.orcaState -eq 'pending-verification' }) {
        $tabId = [string]$entry.data['orca']['tabId']
        $handle = [string]$entry.data['orca']['handle']
        $matches = @($orcaTerminals | Where-Object {
            [string]::Equals([string]$_['tabId'], $tabId, [System.StringComparison]::Ordinal)
        })
        if ($matches.Count -eq 0) {
            $caseConflicts = @($orcaTerminals | Where-Object {
                [string]::Equals([string]$_['tabId'], $tabId, [System.StringComparison]::OrdinalIgnoreCase)
            })
            if ($caseConflicts.Count -gt 0) {
                $entry.orcaState = 'identity-error'
                $errors += "$($entry.data['agent']): Orca tab ID '$tabId' differs only by case from an existing tab."
            }
            else { $entry.orcaState = 'already-closed' }
        }
        elseif ($matches.Count -gt 1) { $entry.orcaState = 'identity-error'; $errors += "$($entry.data['agent']): Orca tab ID '$tabId' is ambiguous." }
        elseif (-not [string]::Equals([string]$matches[0]['handle'], $handle, [System.StringComparison]::Ordinal)) { $entry.orcaState = 'identity-error'; $errors += "$($entry.data['agent']): Orca handle does not match its record." }
        else { $entry.orcaState = 'open' }
    }
}

$hasExternalViews = $needsHerdr -or $needsOrca -or $hasUntrackedExternalView
$cleanupNeeded = @($entries | Where-Object { $_.herdrState -eq 'open' -or $_.orcaState -eq 'open' }).Count -gt 0
$result = [ordered]@{
    runId = $RunId
    preflightOnly = [bool]$PreflightOnly
    hasExternalViews = $hasExternalViews
    cleanupNeeded = $cleanupNeeded
    safeToClose = $errors.Count -eq 0
    closed = $false
    errors = $errors
    views = @($entries | ForEach-Object {
        [ordered]@{
            agent = $_.data['agent']
            childIndex = $_.data['childIndex']
            lifecycle = $_.lifecycle
            herdrState = $_.herdrState
            orcaState = $_.orcaState
        }
    })
}

if ($errors.Count -gt 0 -or $PreflightOnly) {
    [pscustomobject]$result | ConvertTo-Json -Depth 30
    if ($errors.Count -gt 0) { exit 2 }
    exit 0
}

$closeErrors = @()
foreach ($entry in $entries | Where-Object { $_.orcaState -eq 'open' }) {
    $closed = Invoke-JsonCommand -Executable $orca -Arguments @(
        'terminal', 'close', '--terminal', [string]$entry.data['orca']['handle'], '--tab', '--json'
    )
    if ($closed.ok -and $null -ne $closed.value -and $closed.value['ok'] -eq $true) { $entry.orcaState = 'close-requested' }
    else { $entry.orcaState = 'close-failed'; $closeErrors += "$($entry.data['agent']): Orca close failed: $($closed.raw)" }
}

if (@($entries | Where-Object { $_.orcaState -eq 'close-requested' }).Count -gt 0 -and $closeErrors.Count -eq 0) {
    $after = Invoke-JsonCommand -Executable $orca -Arguments @('terminal', 'list', '--json')
    if (-not $after.ok -or $null -eq $after.value -or $after.value['ok'] -ne $true) {
        $closeErrors += "Could not verify Orca cleanup: $($after.raw)"
    }
    else {
        $remaining = @($after.value['result']['terminals'])
        foreach ($entry in $entries | Where-Object { $_.orcaState -eq 'close-requested' }) {
            if (@($remaining | Where-Object {
                [string]::Equals([string]$_['tabId'], [string]$entry.data['orca']['tabId'], [System.StringComparison]::Ordinal)
            }).Count -eq 0) { $entry.orcaState = 'closed' }
            else { $entry.orcaState = 'close-failed'; $closeErrors += "$($entry.data['agent']): Orca tab remained open." }
        }
    }
}

foreach ($entry in $entries | Where-Object { $_.herdrState -eq 'open' }) {
    $closed = Invoke-JsonCommand -Executable $herdr -Arguments @('tab', 'close', [string]$entry.data['herdr']['tabId'])
    if ($closed.ok) { $entry.herdrState = 'close-requested' }
    else { $entry.herdrState = 'close-failed'; $closeErrors += "$($entry.data['agent']): Herdr close failed: $($closed.raw)" }
}

foreach ($entry in $entries | Where-Object { $_.herdrState -eq 'close-requested' }) {
    $listed = Get-HerdrTabs -Executable $herdr -WorkspaceId ([string]$entry.data['herdr']['workspaceId'])
    if (-not $listed.ok) {
        $entry.herdrState = 'close-failed'
        $closeErrors += "$($entry.data['agent']): $($listed.error)"
    }
    elseif (@($listed.tabs | Where-Object {
        [string]::Equals([string]$_['tab_id'], [string]$entry.data['herdr']['tabId'], [System.StringComparison]::Ordinal)
    }).Count -eq 0) {
        $entry.herdrState = 'closed'
    }
    else {
        $entry.herdrState = 'close-failed'
        $closeErrors += "$($entry.data['agent']): Herdr tab remained open."
    }
}

$now = [DateTime]::UtcNow.ToString('o')
foreach ($entry in $entries) {
    $entry.data['updatedAtUtc'] = $now
    $entry.data['herdr']['cleanupState'] = $entry.herdrState
    $entry.data['orca']['cleanupState'] = $entry.orcaState
    Write-JsonFile -Value $entry.data -Path $entry.path
}

$result.closed = $closeErrors.Count -eq 0
$result.safeToClose = $closeErrors.Count -eq 0
$result.cleanupNeeded = @($entries | Where-Object {
    $_.herdrState -in @('open', 'close-requested', 'close-failed') -or
        $_.orcaState -in @('open', 'close-requested', 'close-failed')
}).Count -gt 0
$result.errors = $closeErrors
$result.views = @($entries | ForEach-Object {
    [ordered]@{
        agent = $_.data['agent']
        childIndex = $_.data['childIndex']
        lifecycle = $_.lifecycle
        herdrState = $_.herdrState
        orcaState = $_.orcaState
    }
})
[pscustomobject]$result | ConvertTo-Json -Depth 30
if ($closeErrors.Count -gt 0) { exit 3 }
}
finally {
    if ($null -ne $runClaim) { $runClaim.Dispose() }
}
