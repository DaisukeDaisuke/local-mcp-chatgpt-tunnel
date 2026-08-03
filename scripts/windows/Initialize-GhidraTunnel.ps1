[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TunnelUser = "mcp-tunnel",
    [string]$SecretDirectory = "$env:USERPROFILE\.dq9-mcp",
    [int]$SshPort = 22,
    [switch]$RestrictSshFirewallToDockerInterfaces
)

$ErrorActionPreference = "Stop"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from an elevated PowerShell window."
    }
}

function New-RandomPassword {
    $bytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return ([Convert]::ToBase64String($bytes) + "!aA1")
}

Assert-Administrator
New-Item -ItemType Directory -Force -Path $SecretDirectory | Out-Null

$serverCapability = Get-WindowsCapability -Online | Where-Object Name -Like "OpenSSH.Server*" | Select-Object -First 1
if ($serverCapability.State -ne "Installed") {
    Add-WindowsCapability -Online -Name $serverCapability.Name | Out-Null
}
Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd

$privateKey = Join-Path $SecretDirectory "ghidra_tunnel_ed25519"
$publicKey = "$privateKey.pub"
if (-not (Test-Path -LiteralPath $privateKey)) {
    & ssh-keygen.exe -q -t ed25519 -a 100 -C "dq9-mcp-ghidra-tunnel" -f $privateKey -N ""
    if ($LASTEXITCODE -ne 0) { throw "ssh-keygen failed with exit code $LASTEXITCODE" }
}

$user = Get-LocalUser -Name $TunnelUser -ErrorAction SilentlyContinue
if (-not $user) {
    $password = ConvertTo-SecureString (New-RandomPassword) -AsPlainText -Force
    New-LocalUser -Name $TunnelUser -Password $password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
}
Enable-LocalUser -Name $TunnelUser

$home = Join-Path $env:SystemDrive "Users\$TunnelUser"
$sshDirectory = Join-Path $home ".ssh"
$authorizedKeys = Join-Path $sshDirectory "authorized_keys"
New-Item -ItemType Directory -Force -Path $sshDirectory | Out-Null

$publicKeyText = (Get-Content -LiteralPath $publicKey -Raw -Encoding utf8).Trim()
$restrictedKey = 'command="cmd.exe /d /c exit 0",no-agent-forwarding,no-X11-forwarding,no-pty,permitopen="127.0.0.1:8089",permitopen="127.0.0.1:8099" ' + $publicKeyText
Set-Content -LiteralPath $authorizedKeys -Value $restrictedKey -Encoding ascii -NoNewline

& icacls.exe $home /inheritance:r /grant:r "${TunnelUser}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
& icacls.exe $sshDirectory /inheritance:r /grant:r "${TunnelUser}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
& icacls.exe $authorizedKeys /inheritance:r /grant:r "${TunnelUser}:F" "SYSTEM:F" | Out-Null

$sshdConfig = Join-Path $env:ProgramData "ssh\sshd_config"
$configText = Get-Content -LiteralPath $sshdConfig -Raw -Encoding utf8
$begin = "# BEGIN DQ9 MCP TUNNEL"
$end = "# END DQ9 MCP TUNNEL"
$block = @"
$begin
Match User $TunnelUser
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowAgentForwarding no
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:8089 127.0.0.1:8099
    PermitTTY no
    X11Forwarding no
$end
"@
$pattern = "(?s)$([regex]::Escape($begin)).*?$([regex]::Escape($end))"
if ($configText -match $pattern) {
    $configText = [regex]::Replace($configText, $pattern, $block.Trim())
} else {
    $configText = $configText.TrimEnd() + "`r`n`r`n" + $block.Trim() + "`r`n"
}
Set-Content -LiteralPath $sshdConfig -Value $configText -Encoding ascii

& "$env:WINDIR\System32\OpenSSH\sshd.exe" -t -f $sshdConfig
if ($LASTEXITCODE -ne 0) { throw "sshd_config validation failed" }
Restart-Service -Name sshd

$hostKeyPath = Join-Path $env:ProgramData "ssh\ssh_host_ed25519_key.pub"
$hostKey = (Get-Content -LiteralPath $hostKeyPath -Raw -Encoding ascii).Trim().Split(' ')
if ($hostKey.Count -lt 2 -or $hostKey[0] -ne "ssh-ed25519") { throw "Windows OpenSSH Ed25519 host key was not found" }
$knownHostsPath = Join-Path $SecretDirectory "ghidra_known_hosts"
@(
    "host.docker.internal $($hostKey[0]) $($hostKey[1])",
    "[host.docker.internal]:$SshPort $($hostKey[0]) $($hostKey[1])"
) | Set-Content -LiteralPath $knownHostsPath -Encoding ascii

if ($RestrictSshFirewallToDockerInterfaces) {
    $aliases = @(Get-NetAdapter | Where-Object { $_.Status -eq "Up" -and $_.Name -like "vEthernet*" } | Select-Object -ExpandProperty Name)
    if ($aliases.Count -eq 0) { throw "No active vEthernet interface was found. Do not disable the broad OpenSSH rule manually until Docker connectivity is verified." }
    Get-NetFirewallRule -DisplayName "DQ9 MCP OpenSSH Docker only" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "DQ9 MCP OpenSSH Docker only" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $SshPort -InterfaceAlias $aliases -Profile Any | Out-Null
    Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue | Disable-NetFirewallRule
}

Write-Host "Created restricted Ed25519 tunnel identity."
Write-Host "Private key: $privateKey"
Write-Host "Pinned host key: $knownHostsPath"
Write-Host "Set GHIDRA_SSH_KEY_PATH and GHIDRA_KNOWN_HOSTS_PATH to these files in .env."
