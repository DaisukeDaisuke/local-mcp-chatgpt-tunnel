[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Prompt
)

$ErrorActionPreference = "Stop"
docker compose run --rm app node app/cli.mjs $Prompt
if ($LASTEXITCODE -ne 0) { throw "Assistant invocation failed" }
