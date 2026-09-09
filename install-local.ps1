[CmdletBinding()]
param([switch]$RestoreUpstream, [switch]$SkipDependencies)
$ErrorActionPreference = 'Stop'
$taskPackageRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$taskAgentRoot = Split-Path (Split-Path $taskPackageRoot -Parent) -Parent
$taskSettingsPath = Join-Path $taskAgentRoot 'settings.json'
$taskPackage = Get-Content -LiteralPath (Join-Path $taskPackageRoot 'package.json') -Raw | ConvertFrom-Json
if ($taskPackage.version -ne '0.66.0-pi-bots.1') { throw 'Unexpected local fork version.' }
if (-not $RestoreUpstream -and -not $SkipDependencies) {
    # Loaded ConPTY DLLs cannot be replaced on Windows. Check before npm ci can
    # partially remove a dependency tree that running children still require.
    $taskBrokerPath = (Join-Path $taskPackageRoot 'src/tui-host/broker.mjs').Replace('\','/')
    $taskActiveBrokers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Replace('\','/').Contains($taskBrokerPath)
    })
    if ($taskActiveBrokers.Count -gt 0) { throw 'Active Pi TUI hosts are using this dependency tree. Keep the current installation with -SkipDependencies, or explicitly stop/retire its children before npm ci.' }
    Push-Location -LiteralPath $taskPackageRoot
    try {
        & npm.cmd ci --omit=dev --legacy-peer-deps --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed; settings were not changed.' }
        & npm.cmd test
        if ($LASTEXITCODE -ne 0) { throw 'Fork tests failed; settings were not changed.' }
    } finally { Pop-Location }
}
$taskSettings = Get-Content -LiteralPath $taskSettingsPath -Raw | ConvertFrom-Json
$taskBackupDir = Join-Path (Split-Path $taskAgentRoot -Parent) ('backups\pi-subagents-local-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskBackupDir -Force | Out-Null
Copy-Item -LiteralPath $taskSettingsPath -Destination (Join-Path $taskBackupDir 'settings.json')
$taskSource = if ($RestoreUpstream) { 'npm:pi-subagents@0.66.0' } else { 'local-packages\pi-subagents' }
$taskPackages = @($taskSettings.packages | Where-Object {
    $_ -isnot [string] -or ($_ -notmatch '^npm:pi-subagents(?:@|$)' -and $_ -notmatch '^local-packages[\\/]pi-subagents$')
})
$taskSettings.packages = @($taskPackages + $taskSource)
$taskTempPath = $taskSettingsPath + '.' + [Guid]::NewGuid().ToString() + '.tmp'
[IO.File]::WriteAllText($taskTempPath, ($taskSettings | ConvertTo-Json -Depth 100) + "`n", [Text.UTF8Encoding]::new($false))
[IO.File]::Replace($taskTempPath, $taskSettingsPath, (Join-Path $taskBackupDir 'settings-at-replace.json'))
Write-Output "Selected $taskSource. Reload Pi to use it. Settings backup: $taskBackupDir"
