[CmdletBinding()]
param(
    [switch]$SkipWinget,
    [string]$ToolsDirectory
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $ToolsDirectory) { $ToolsDirectory = Join-Path $repoRoot ".tools" }

function Install-WingetPackage {
    param([Parameter(Mandatory = $true)][string]$Id)
    winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "winget install failed for $Id" }
}

if (-not $SkipWinget) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "winget is unavailable. Install or update App Installer first." }
    Install-WingetPackage "OpenJS.NodeJS.LTS"
    Install-WingetPackage "Python.Python.3.12"
    Install-WingetPackage "Git.Git"
    Install-WingetPackage "Google.Chrome"
    $applyPatchSearch = winget search --id apply_patch --exact --source winget --accept-source-agreements --disable-interactivity 2>&1 | Out-String
    Write-Host "winget exact-ID check for apply_patch completed. No package is installed from this result."
    if ($applyPatchSearch.Trim()) { Write-Verbose $applyPatchSearch }
    Write-Host "Using the repository's dedicated files__apply_patch implementation and Git.Git for unified diffs."
}

$architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "windows-arm64" } else { "windows-amd64" }
$release = Invoke-RestMethod -Headers @{ "User-Agent" = "dq9-local-mcp-setup" } -Uri "https://api.github.com/repos/openai/tunnel-client/releases/latest"
$zipAsset = $release.assets | Where-Object { $_.name -eq "$architecture.zip" } | Select-Object -First 1
$checksumAsset = $release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1
if (-not $zipAsset -or -not $checksumAsset) { throw "The latest tunnel-client release does not contain $architecture.zip and SHA256SUMS.txt" }

$destination = Join-Path $ToolsDirectory "tunnel-client"
$downloadDirectory = Join-Path $env:TEMP ("tunnel-client-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $downloadDirectory, $destination | Out-Null
try {
    $zipPath = Join-Path $downloadDirectory $zipAsset.name
    $checksumsPath = Join-Path $downloadDirectory "SHA256SUMS.txt"
    Invoke-WebRequest -UseBasicParsing -Uri $zipAsset.browser_download_url -OutFile $zipPath
    Invoke-WebRequest -UseBasicParsing -Uri $checksumAsset.browser_download_url -OutFile $checksumsPath
    $expectedLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "\s+$([Regex]::Escape($zipAsset.name))$" } | Select-Object -First 1
    if (-not $expectedLine) { throw "Checksum for $($zipAsset.name) was not published" }
    $expected = ($expectedLine -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "tunnel-client checksum mismatch" }
    Remove-Item -Recurse -Force $destination
    New-Item -ItemType Directory -Force $destination | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $destination -Force
    $binary = Get-ChildItem -LiteralPath $destination -Filter "tunnel-client.exe" -Recurse | Select-Object -First 1
    if (-not $binary) { throw "tunnel-client.exe was not found after extraction" }
    if ($binary.DirectoryName -ne $destination) { Copy-Item -LiteralPath $binary.FullName -Destination (Join-Path $destination "tunnel-client.exe") -Force }
    [IO.File]::WriteAllText((Join-Path $destination "VERSION.txt"), $release.tag_name, (New-Object Text.UTF8Encoding($false)))
} finally {
    Remove-Item -Recurse -Force $downloadDirectory -ErrorAction SilentlyContinue
}

Write-Host "Installed tunnel-client $($release.tag_name) to $destination"