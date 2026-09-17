$ErrorActionPreference = 'Stop'

$tunnelId = 'tbk-b147bfa6'
$localHealthUrl = 'http://127.0.0.1:8787/api/health'
$publicHealthUrl = 'https://vjqm1hqc-8787.jpe1.devtunnels.ms/api/health'
$logDir = Join-Path $env:LOCALAPPDATA 'thiefbook\logs'
$supervisorLog = Join-Path $logDir 'tunnel-supervisor.log'
$createdNew = $false
$instanceMutex = New-Object System.Threading.Mutex($true, 'Local\ThiefBookTunnelSupervisor', [ref]$createdNew)

if (-not $createdNew) { exit 0 }

# Task Scheduler may keep an old environment block for an already-running
# logon session.  Reload the user's proxy settings explicitly so devtunnel can
# refresh its Microsoft sign-in token after Windows restarts.
$userEnvironment = Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue
if ($userEnvironment.http_proxy) { $env:http_proxy = [string]$userEnvironment.http_proxy }
if ($userEnvironment.https_proxy) { $env:https_proxy = [string]$userEnvironment.https_proxy }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-SupervisorLog([string]$message) {
  Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) $message" -Encoding UTF8
}

function Find-DevTunnel {
  $command = Get-Command devtunnel.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $packageRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  $match = Get-ChildItem -LiteralPath $packageRoot -Filter 'Microsoft.devtunnel_*' -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'devtunnel.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
  if ($match) { return $match }
  throw 'devtunnel.exe was not found'
}

function Invoke-TunnelRenewal([string]$devTunnel) {
  # Renewal must be best-effort: an unavailable proxy must not take the public
  # endpoint offline.  Return a Boolean so failed renewals can be retried soon.
  Write-SupervisorLog "refreshing tunnel expiration: $tunnelId"
  $updateStdout = Join-Path $logDir 'tunnel-update.out.log'
  $updateStderr = Join-Path $logDir 'tunnel-update.err.log'
  $updateProcess = Start-Process -FilePath $devTunnel -ArgumentList @('update', $tunnelId, '--expiration', '30d') `
    -WindowStyle Hidden -RedirectStandardOutput $updateStdout -RedirectStandardError $updateStderr -PassThru
  $updateExited = $updateProcess.WaitForExit(30000)
  if (-not $updateExited) {
    Stop-Process -Id $updateProcess.Id -Force -ErrorAction SilentlyContinue
    Write-SupervisorLog "tunnel renewal timed out; continuing with existing tunnel"
    return $false
  }

  # Wait for redirected streams to flush.  Windows PowerShell can leave the
  # ExitCode property unset for this Start-Process shape, so use stderr as the
  # reliable failure signal as well.
  $updateProcess.WaitForExit()
  $updateProcess.Refresh()
  $updateError = ''
  if (Test-Path -LiteralPath $updateStderr) {
    $rawUpdateError = Get-Content -LiteralPath $updateStderr -Raw
    if (-not [string]::IsNullOrWhiteSpace($rawUpdateError)) {
      $updateError = $rawUpdateError.Trim()
    }
  }
  if (($null -ne $updateProcess.ExitCode -and $updateProcess.ExitCode -ne 0) -or $updateError) {
    $exitCodeText = if ($null -eq $updateProcess.ExitCode) { 'unknown' } else { [string]$updateProcess.ExitCode }
    Write-SupervisorLog "tunnel renewal failed with exit code $exitCodeText; continuing with existing tunnel"
    return $false
  }

  Write-SupervisorLog "tunnel renewal completed"
  return $true
}

while ($true) {
  try {
    Get-ChildItem -LiteralPath $logDir -Filter 'tunnel-run-*.log' -File -ErrorAction SilentlyContinue |
      Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) |
      Remove-Item -Force

    $devTunnel = Find-DevTunnel
    # Renewal is useful, but it must never prevent the public endpoint from
    # coming online after Windows starts.  The CLI can hang here while the
    # proxy/network stack is still warming up after sign-in.
    $renewalSucceeded = Invoke-TunnelRenewal $devTunnel

    while ($true) {
      try {
        $local = Invoke-RestMethod -Uri $localHealthUrl -TimeoutSec 5
        if ($local.ok -eq $true) { break }
      } catch {
        Write-SupervisorLog "waiting for local server: $($_.Exception.Message)"
      }
      Start-Sleep -Seconds 10
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $logDir "tunnel-run-$stamp.out.log"
    $stderrLog = Join-Path $logDir "tunnel-run-$stamp.err.log"
    Write-SupervisorLog "starting dev tunnel: $devTunnel"
    $process = Start-Process -FilePath $devTunnel -ArgumentList @('host', $tunnelId) -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

    # devtunnel can remain alive while its SSH forwarding window is wedged.
    # Probe the actual public path and recycle the host after consecutive failures.
    $nextRenewal = if ($renewalSucceeded) { (Get-Date).AddDays(7) } else { (Get-Date).AddHours(1) }
    $failedPublicChecks = 0
    while (-not $process.HasExited) {
      try {
        $publicHealth = Invoke-RestMethod -Uri $publicHealthUrl -TimeoutSec 8
        if ($publicHealth.ok -ne $true) { throw 'public health response did not contain ok=true' }
        $failedPublicChecks = 0
      } catch {
        $failedPublicChecks++
        Write-SupervisorLog "public health failed ($failedPublicChecks/3): $($_.Exception.Message)"
        if ($failedPublicChecks -ge 3 -and -not $process.HasExited) {
          Write-SupervisorLog "restarting unhealthy tunnel pid=$($process.Id)"
          Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
          break
        }
      }
      if ((Get-Date) -ge $nextRenewal) {
        $renewalSucceeded = Invoke-TunnelRenewal $devTunnel
        $nextRenewal = if ($renewalSucceeded) { (Get-Date).AddDays(7) } else { (Get-Date).AddHours(1) }
      }
      Start-Sleep -Seconds 12
    }

    $process.WaitForExit()
    Write-SupervisorLog "dev tunnel exited pid=$($process.Id) code=$($process.ExitCode); retrying in 10 seconds"
  } catch {
    Write-SupervisorLog "supervisor error: $($_.Exception.Message); retrying in 15 seconds"
  }
  Start-Sleep -Seconds 10
}
