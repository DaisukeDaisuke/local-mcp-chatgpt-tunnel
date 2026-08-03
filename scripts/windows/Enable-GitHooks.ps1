[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
git config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw "Failed to configure Git hooks" }
Write-Host "Git hooks enabled from .githooks."
