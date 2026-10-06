$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-log-maintenance.ps1')

$tunnelId = 'tbk-b147bfa6'
$localHealthUrl = 'http://127.0.0.1:8787/api/health'
$publicHealthUrl = 'https://vjqm1hqc-8787.jpe1.devtunnels.ms/api/health'
$logDir = Join-Path $env:LOCALAPPDATA 'thiefbook\logs'
$supervisorLog = Join-Path $logDir 'tunnel-supervisor.log'
$createdNew = $false
$instanceMutex = New-Object System.Threading.Mutex($true, 'Local\ThiefBookTunnelSupervisor', [ref]$createdNew)

if (-not $createdNew) { exit 0 }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-SupervisorLog([string]$message) {
  Write-ServiceSupervisorLog -Path $supervisorLog -Message $message
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

function Sync-UserProxyEnvironment {
  # A long-running supervisor keeps the environment block from when it was
  # launched. Reload proxy settings before every reconnect so devtunnel can
  # refresh its Microsoft token after the user's network settings change.
  $userEnvironment = Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue
  if ($userEnvironment.http_proxy) { $env:http_proxy = [string]$userEnvironment.http_proxy }
  if ($userEnvironment.https_proxy) { $env:https_proxy = [string]$userEnvironment.https_proxy }
}

function Invoke-IntegratedLogin([string]$devTunnel) {
  $loginStdout = Join-Path $logDir 'tunnel-login.out.log'
  $loginStderr = Join-Path $logDir 'tunnel-login.err.log'
  Write-SupervisorLog 'refreshing Microsoft tunnel credentials'
  $login = Start-Process -FilePath $devTunnel -ArgumentList @('user', 'login', '--use-integrated-windows-auth') `
    -WindowStyle Hidden -RedirectStandardOutput $loginStdout -RedirectStandardError $loginStderr -PassThru
  if (-not $login.WaitForExit(30000)) {
    Stop-Process -Id $login.Id -Force -ErrorAction SilentlyContinue
    Write-SupervisorLog 'credential refresh timed out'
    return $false
  }
  $login.WaitForExit()
  $login.Refresh()
  $output = if (Test-Path -LiteralPath $loginStdout) { Get-Content -LiteralPath $loginStdout -Raw } else { '' }
  $errorOutput = if (Test-Path -LiteralPath $loginStderr) { Get-Content -LiteralPath $loginStderr -Raw } else { '' }
  if ($login.ExitCode -ne 0 -or $output -notmatch 'Logged in as' -or -not [string]::IsNullOrWhiteSpace($errorOutput)) {
    Write-SupervisorLog "credential refresh failed (exit code $($login.ExitCode))"
    return $false
  }
  Write-SupervisorLog 'Microsoft tunnel credentials refreshed'
  return $true
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

$nextRenewal = (Get-Date).AddDays(7)
$nextLoginAttempt = Get-Date
$lastLoginAttempt = (Get-Date).AddDays(-1)
while ($true) {
  try {
    Sync-UserProxyEnvironment

    Get-ChildItem -LiteralPath $logDir -Filter 'tunnel-run-*.log' -File -ErrorAction SilentlyContinue |
      Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) |
      Remove-Item -Force

    $devTunnel = Find-DevTunnel

    # The cached identity can be present while its relay token has expired.
    # Refresh it in this same desktop session before trying to host again.
    if ((Get-Date) -ge $nextLoginAttempt) {
      $lastLoginAttempt = Get-Date
      $loginSucceeded = Invoke-IntegratedLogin $devTunnel
      $nextLoginAttempt = if ($loginSucceeded) { (Get-Date).AddHours(12) } else { (Get-Date).AddMinutes(5) }
    }
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
    $hostError = if (Test-Path -LiteralPath $stderrLog) { Get-Content -LiteralPath $stderrLog -Raw } else { '' }
    if ($hostError -match '(?i)Unauthorized|Login required') {
      Write-SupervisorLog 'tunnel host rejected credentials; scheduling refresh'
      $nextLoginAttempt = $lastLoginAttempt.AddMinutes(5)
    }
    Write-SupervisorLog "dev tunnel exited pid=$($process.Id) code=$($process.ExitCode); retrying in 10 seconds"
  } catch {
    Write-SupervisorLog "supervisor error: $($_.Exception.Message); retrying in 15 seconds"
  }
  Start-Sleep -Seconds 10
}
