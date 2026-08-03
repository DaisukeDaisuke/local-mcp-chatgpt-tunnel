[CmdletBinding()]
param(
    [switch]$Build
)

$ErrorActionPreference = "Stop"
if ($Build) {
    docker compose build
    if ($LASTEXITCODE -ne 0) { throw "docker compose build failed" }
}
docker compose run --rm app node app/doctor.mjs
if ($LASTEXITCODE -ne 0) { throw "Docker suite doctor failed" }
