[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')][string]$RunId,
    [Parameter(Mandatory = $true)][string]$AsyncDir,
    [Parameter(Mandatory = $true)][ValidateRange(0, 100000)][int]$ChildIndex,
    [string]$Title = 'Pi Bot',
    [int]$IntervalMilliseconds = 750,
    # Compatibility only: chat pagination has no tail cap.
    [int]$TailLines = 500,
    [int]$TailBytes = 262144,
    [ValidateRange(0, 100000)][int]$MaxRefreshes = 0
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($AsyncDir)) { throw 'AsyncDir must be absolute.' }
$viewerNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path -LiteralPath $viewerNode -PathType Leaf)) { throw "Node.js is unavailable at $viewerNode" }
& $viewerNode (Join-Path $PSScriptRoot 'chat-viewer.mjs') $RunId $AsyncDir $ChildIndex $Title $MaxRefreshes
if ($LASTEXITCODE -ne 0) { throw "Chat viewer exited with code $LASTEXITCODE" }