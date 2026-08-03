[CmdletBinding()]
param(
    [string]$Path = (Join-Path $env:USERPROFILE ".dq9-mcp\tunnel-runtime-key")
)

$ErrorActionPreference = "Stop"
$secure = Read-Host "Paste the tunnel runtime API key" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plain)) { throw "The runtime key is empty" }
    New-Item -ItemType Directory -Force (Split-Path $Path -Parent) | Out-Null
    [IO.File]::WriteAllText($Path, $plain.Trim(), (New-Object Text.UTF8Encoding($false)))
} finally {
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    Remove-Variable plain -ErrorAction SilentlyContinue
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $Path /inheritance:r /grant:r "${identity}:(R,W)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to restrict the runtime key ACL" }
Write-Host "Stored the runtime key at $Path with inheritance disabled."