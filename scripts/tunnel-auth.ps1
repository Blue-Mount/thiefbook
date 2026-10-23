# Keep short-lived, connect-only credentials in memory; never log tokens.
function Get-ThiefBookTunnelHeaders {
  param([Parameter(Mandatory = $true)][string]$DevTunnel,
        [string]$TunnelId = 'tbk-b147bfa6')

  if ($TunnelId -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Invalid tunnel ID' }
  if ($script:ThiefBookConnectToken -and $script:ThiefBookConnectExpiry -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) {
    return @{ 'X-Tunnel-Authorization' = "tunnel $script:ThiefBookConnectToken" }
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $DevTunnel
  $startInfo.Arguments = "token $TunnelId --scopes connect --json"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $tokenProcess = New-Object System.Diagnostics.Process
  $tokenProcess.StartInfo = $startInfo
  try {
    [void]$tokenProcess.Start()
    $stdoutTask = $tokenProcess.StandardOutput.ReadToEndAsync()
    $stderrTask = $tokenProcess.StandardError.ReadToEndAsync()
    if (-not $tokenProcess.WaitForExit(30000)) {
      $tokenProcess.Kill()
      throw 'Tunnel health credential request timed out'
    }
    $tokenProcess.WaitForExit()
    if ($tokenProcess.ExitCode -ne 0) { throw 'Tunnel health credential request failed; check Microsoft sign-in' }
    try { $credential = $stdoutTask.GetAwaiter().GetResult() | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Invalid tunnel health credential response' }
    if (-not $credential.token -or $credential.scope -ne 'connect') { throw 'Invalid tunnel health credential scope' }
    try {
      $expiry = [DateTimeOffset]::Parse(
        ([string]$credential.expiration -replace ' UTC$', ' +00:00'),
        [Globalization.CultureInfo]::InvariantCulture)
    }
    catch { throw 'Invalid tunnel health credential expiration' }
    if ($expiry -le [DateTimeOffset]::UtcNow.AddMinutes(1)) { throw 'Tunnel health credential is expired' }
    $script:ThiefBookConnectToken = [string]$credential.token
    $script:ThiefBookConnectExpiry = $expiry
    return @{ 'X-Tunnel-Authorization' = "tunnel $script:ThiefBookConnectToken" }
  } finally {
    $tokenProcess.Dispose()
  }
}

function Find-ThiefBookDevTunnel {
  $command = Get-Command devtunnel.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $packageRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  $match = Get-ChildItem -LiteralPath $packageRoot -Filter 'Microsoft.devtunnel_*' -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'devtunnel.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($match) { return $match }
  throw 'devtunnel.exe was not found'
}

function Invoke-ThiefBookTunnelHealth {
  param([Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$DevTunnel,
        [string]$TunnelId = 'tbk-b147bfa6', [int]$TimeoutSec = 8)
  # Refresh once on an early token revocation, without restarting a healthy host.
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    try {
      $headers = Get-ThiefBookTunnelHeaders -DevTunnel $DevTunnel -TunnelId $TunnelId
      $health = Invoke-RestMethod -Uri $Url -Headers $headers -TimeoutSec $TimeoutSec
      if ($health.ok -ne $true) { throw 'Private tunnel health response did not contain ok=true' }
      return $health
    } catch {
      $statusCode = 0
      if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
      if ($attempt -eq 0 -and $statusCode -in @(401, 403)) {
        $script:ThiefBookConnectToken = $null
        continue
      }
      throw
    }
  }
}
