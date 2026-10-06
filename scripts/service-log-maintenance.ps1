# Keep restart diagnostics bounded; never remove logs belonging to live processes.
function Remove-ServiceRunLogs {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [int]$KeepRuns = 40,
    [int]$KeepDays = 14,
    [string[]]$ProtectedPrefixes = @()
  )

  $resolvedDirectory = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $resolvedDirectory -PathType Container)) { return 0 }
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  $removed = 0
  foreach ($component in @('server', 'tunnel')) {
    $files = @(Get-ChildItem -LiteralPath $resolvedDirectory -Filter "$component-run-*.log" -File |
      Where-Object { $_.Name -match "^$component-run-\d{8}-\d{6}\.(out|err)\.log$" })
    $runs = @($files | Group-Object { $_.Name.Substring(0, 26) } | Sort-Object Name -Descending)
    for ($index = 0; $index -lt $runs.Count; $index++) {
      if ($runs[$index].Name -in $ProtectedPrefixes) { continue }
      foreach ($file in $runs[$index].Group) {
        if ($index -lt $KeepRuns -and $file.LastWriteTime -ge $cutoff) { continue }
        # All deletion stays in this exact log directory, with no recursion.
        if (-not [string]::Equals($file.DirectoryName, $resolvedDirectory, [StringComparison]::OrdinalIgnoreCase)) {
          throw "Log path escaped the selected directory: $($file.FullName)"
        }
        try {
          Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
          $removed++
        } catch {
          # Redirected output may still have an open handle; preserve that file.
        }
      }
    }
  }
  return $removed
}

function Write-ServiceSupervisorLog {
  param([string]$Path, [string]$Message)
  try {
    if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -ge 1MB) {
      if (Test-Path -LiteralPath "$Path.2") { Remove-Item -LiteralPath "$Path.2" -Force }
      if (Test-Path -LiteralPath "$Path.1") { Move-Item -LiteralPath "$Path.1" -Destination "$Path.2" }
      Move-Item -LiteralPath $Path -Destination "$Path.1"
    }
    Add-Content -LiteralPath $Path -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
  } catch {
    Write-Warning "Could not write supervisor log: $($_.Exception.Message)"
  }
}
