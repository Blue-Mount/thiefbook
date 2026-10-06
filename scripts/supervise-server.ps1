$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-log-maintenance.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $projectRoot 'server'
$logDir = Join-Path $env:LOCALAPPDATA 'thiefbook\logs'
$supervisorLog = Join-Path $logDir 'server-supervisor.log'
$healthUrl = 'http://127.0.0.1:8787/api/health'
$createdNew = $false
$instanceMutex = New-Object System.Threading.Mutex($true, 'Local\ThiefBookServerSupervisor', [ref]$createdNew)

if (-not $createdNew) { exit 0 }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-SupervisorLog([string]$message) {
  Write-ServiceSupervisorLog -Path $supervisorLog -Message $message
}

function Find-Node {
  $preferred = 'C:\Code\Nodejs\node.exe'
  if (Test-Path -LiteralPath $preferred) { return $preferred }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw 'node.exe was not found'
}

$observedState = ''
$retrySeconds = 5
$nextCleanup = (Get-Date).AddHours(1)
while ($true) {
  try {
    if ((Get-Date) -ge $nextCleanup) {
      $protected = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe', 'devtunnel.exe') } |
        ForEach-Object {
          $component = if ($_.Name -eq 'node.exe') { 'server' } else { 'tunnel' }
          "$component-run-$($_.CreationDate.ToString('yyyyMMdd-HHmmss'))"
        })
      $removed = Remove-ServiceRunLogs -Directory $logDir -ProtectedPrefixes $protected
      if ($removed) { Write-SupervisorLog "removed $removed expired or excess run logs" }
      $nextCleanup = (Get-Date).AddHours(1)
    }

    # A service started outside this supervisor can already own the port.
    # Monitor it instead of launching a second node that can only fail to bind.
    $listener = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      $healthy = $false
      try { $healthy = (Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5).ok -eq $true } catch {}
      $state = "$($listener.OwningProcess):$healthy"
      if ($state -ne $observedState) {
        if ($healthy) {
          Write-SupervisorLog "monitoring existing healthy server pid=$($listener.OwningProcess); no duplicate launch"
        } else {
          Write-SupervisorLog "port 8787 is occupied by pid=$($listener.OwningProcess) but health check failed; waiting for port release"
        }
        $observedState = $state
      }
      if ($healthy) { $retrySeconds = 5 }
      Start-Sleep -Seconds 10
      continue
    }
    $observedState = ''

    $nodePath = Find-Node
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $logDir "server-run-$stamp.out.log"
    $stderrLog = Join-Path $logDir "server-run-$stamp.err.log"
    Write-SupervisorLog "starting node: $nodePath"

    $runStartedAt = Get-Date
    $process = Start-Process -FilePath $nodePath -ArgumentList 'index.js' -WorkingDirectory $serverDir `
      -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

    $failedChecks = 0
    while (-not $process.HasExited) {
      Start-Sleep -Seconds 10
      try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
        if ($health.ok -ne $true) { throw 'health response did not contain ok=true' }
        $failedChecks = 0
      } catch {
        $failedChecks++
        Write-SupervisorLog "local health failed ($failedChecks/3): $($_.Exception.Message)"
        if ($failedChecks -ge 3 -and -not $process.HasExited) {
          Write-SupervisorLog "stopping unhealthy node pid=$($process.Id)"
          Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
      }
    }

    $process.WaitForExit()
    $process.Refresh()
    if (((Get-Date) - $runStartedAt).TotalSeconds -ge 60) { $retrySeconds = 5 }
    Write-SupervisorLog "node exited pid=$($process.Id) code=$($process.ExitCode); retrying in $retrySeconds seconds"
  } catch {
    Write-SupervisorLog "supervisor error: $($_.Exception.Message); retrying in 10 seconds"
    $retrySeconds = [Math]::Max(10, $retrySeconds)
  }
  Start-Sleep -Seconds $retrySeconds
  $retrySeconds = [Math]::Min(300, $retrySeconds * 2)
}
