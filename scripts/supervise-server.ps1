$ErrorActionPreference = 'Stop'

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
  Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) $message" -Encoding UTF8
}

function Find-Node {
  $preferred = 'C:\Code\Nodejs\node.exe'
  if (Test-Path -LiteralPath $preferred) { return $preferred }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw 'node.exe was not found'
}

while ($true) {
  try {
    Get-ChildItem -LiteralPath $logDir -Filter 'server-run-*.log' -File -ErrorAction SilentlyContinue |
      Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) |
      Remove-Item -Force

    $nodePath = Find-Node
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $logDir "server-run-$stamp.out.log"
    $stderrLog = Join-Path $logDir "server-run-$stamp.err.log"
    Write-SupervisorLog "starting node: $nodePath"

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
    Write-SupervisorLog "node exited pid=$($process.Id) code=$($process.ExitCode); retrying in 5 seconds"
  } catch {
    Write-SupervisorLog "supervisor error: $($_.Exception.Message); retrying in 10 seconds"
    Start-Sleep -Seconds 5
  }
  Start-Sleep -Seconds 5
}
