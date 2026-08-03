[CmdletBinding()]
param(
    [switch]$InstallDependencies
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $repoRoot

if ($InstallDependencies) { & (Join-Path $PSScriptRoot "Install-Dependencies.ps1") }

New-Item -ItemType Directory -Force "workspace", ".runtime" | Out-Null
if (-not (Test-Path "config\gateway.json")) { Copy-Item "config\gateway.example.json" "config\gateway.json" }
if (-not (Test-Path "config\dq9-runtime.json")) { Copy-Item "config\dq9-runtime.example.json" "config\dq9-runtime.json" }

npm install --no-audit --no-fund --no-package-lock
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

$python = Get-Command py -ErrorAction SilentlyContinue
if ($python) {
    py -3.12 -m venv .venv
} else {
    python -m venv .venv
}
if ($LASTEXITCODE -ne 0) { throw "Python virtual environment creation failed" }

& ".\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-cache-dir -r "mcp\ghidra\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "Ghidra MCP Python dependency installation failed" }

git config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw "Failed to enable repository Git hooks" }

Write-Host "Initialization completed. Edit config\gateway.json and config\dq9-runtime.json, then run scripts\windows\Test-LocalMcp.ps1."