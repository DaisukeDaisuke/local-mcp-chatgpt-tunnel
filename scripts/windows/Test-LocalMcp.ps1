[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $repoRoot
node app\doctor.mjs
if ($LASTEXITCODE -ne 0) { throw "Doctor failed" }
npm test
if ($LASTEXITCODE -ne 0) { throw "Tests failed" }