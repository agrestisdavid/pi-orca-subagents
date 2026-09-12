param()
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'migrate-local.mjs')
if ($LASTEXITCODE -ne 0) { throw 'POS migration failed. See the reported backup path.' }
