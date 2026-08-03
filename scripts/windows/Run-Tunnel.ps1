[CmdletBinding()]
param(
    [string]$Profile = "dq9-local",
    [string]$RuntimeKeyPath = (Join-Path $env:USERPROFILE ".dq9-mcp\tunnel-runtime-key"),
    [string]$TunnelClientPath
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $TunnelClientPath) { $TunnelClientPath = Join-Path $repoRoot ".tools\tunnel-client\tunnel-client.exe" }
if (-not (Test-Path -LiteralPath $TunnelClientPath)) { throw "tunnel-client.exe is missing" }
if (-not (Test-Path -LiteralPath $RuntimeKeyPath)) { throw "Runtime key file is missing" }

$key = [IO.File]::ReadAllText($RuntimeKeyPath, [Text.Encoding]::UTF8).Trim()
if (-not $key) { throw "Runtime key file is empty" }
$previous = $env:CONTROL_PLANE_API_KEY
try {
    $env:CONTROL_PLANE_API_KEY = $key
    & $TunnelClientPath run --profile $Profile
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client exited with code $LASTEXITCODE" }
} finally {
    $env:CONTROL_PLANE_API_KEY = $previous
    Remove-Variable key -ErrorAction SilentlyContinue
}