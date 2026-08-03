[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^tunnel_[A-Za-z0-9]+$')][string]$TunnelId,
    [string]$Profile = "dq9-local",
    [string]$RuntimeKeyPath = (Join-Path $env:USERPROFILE ".dq9-mcp\tunnel-runtime-key"),
    [string]$TunnelClientPath
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $TunnelClientPath) { $TunnelClientPath = Join-Path $repoRoot ".tools\tunnel-client\tunnel-client.exe" }
if (-not (Test-Path -LiteralPath $TunnelClientPath)) { throw "tunnel-client.exe is missing. Run Install-Dependencies.ps1 first." }
if (-not (Test-Path -LiteralPath $RuntimeKeyPath)) { throw "Runtime key file is missing. Run Set-TunnelRuntimeKey.ps1 first." }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "config\gateway.json"))) { throw "config\gateway.json is missing. Run Initialize-LocalMcp.ps1 first." }

$key = [IO.File]::ReadAllText($RuntimeKeyPath, [Text.Encoding]::UTF8).Trim()
if (-not $key) { throw "Runtime key file is empty" }
$previous = $env:CONTROL_PLANE_API_KEY
try {
    $env:CONTROL_PLANE_API_KEY = $key
    $gateway = Join-Path $repoRoot "app\gateway.mjs"
    $mcpCommand = '"{0}" "{1}"' -f (Get-Command node).Source, $gateway
    & $TunnelClientPath init --sample sample_mcp_stdio_local --profile $Profile --tunnel-id $TunnelId --mcp-command $mcpCommand
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client init failed" }
    & $TunnelClientPath doctor --profile $Profile --explain
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor failed" }
} finally {
    $env:CONTROL_PLANE_API_KEY = $previous
    Remove-Variable key -ErrorAction SilentlyContinue
}