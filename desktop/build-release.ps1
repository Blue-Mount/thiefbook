param(
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectDir = $PSScriptRoot
$repoDir = Split-Path -Parent $projectDir
$decryptTool = 'D:\Code\code\toolsForAI\decrypt_inplace.ps1'

# npm 在部分环境会重写 PSModulePath，导致子 powershell.exe 找不到 Get-FileHash。
$windowsPowerShellModules = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$modulePaths = @($env:PSModulePath -split ';')
if ($modulePaths -notcontains $windowsPowerShellModules) {
  $env:PSModulePath = $windowsPowerShellModules + ';' + $env:PSModulePath
}

function Invoke-VerifiedDecrypt {
  param([Parameter(Mandatory = $true)][string]$Target)

  if (-not (Test-Path -LiteralPath $Target)) {
    throw "解密目标不存在: $Target"
  }

  $decryptOutput = @(
    & powershell.exe -NoProfile -NonInteractive -File $decryptTool $Target 2>&1
  )
  $decryptExitCode = $LASTEXITCODE
  $decryptOutput | ForEach-Object { Write-Host $_ }

  $failLines = @($decryptOutput | Where-Object { "$_" -match '^FAIL\s' })
  $okLines = @($decryptOutput | Where-Object { "$_" -match '^OK\s' })
  if ($decryptExitCode -ne 0 -or $failLines.Count -gt 0 -or $okLines.Count -eq 0) {
    throw "解密或 SHA-256 校验失败: $Target"
  }
}

if (-not (Test-Path -LiteralPath $decryptTool)) {
  throw "固定解密工具不存在: $decryptTool"
}

# electron-builder 不能透明读取 CDGServer3 密文。打包前必须先把所有实际输入转为磁盘明文，
# 否则构建虽然退出 0，生成物里封装的仍可能是加密后的源码字节。
$sourceTargets = @(
  (Join-Path $projectDir 'main.js'),
  (Join-Path $projectDir 'preload.js'),
  (Join-Path $projectDir 'renderer'),
  (Join-Path $projectDir 'package.json'),
  (Join-Path $projectDir 'package-lock.json'),
  (Join-Path $repoDir 'app\public\books')
)
foreach ($target in $sourceTargets) {
  Invoke-VerifiedDecrypt -Target $target
}

$package = Get-Content -LiteralPath (Join-Path $projectDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw 'package.json 缺少 version'
}

$relativeOutput = "dist-release/$version"
$outputDir = Join-Path $projectDir ("dist-release\" + $version)
$builder = Join-Path $projectDir 'node_modules\.bin\electron-builder.cmd'
if (-not (Test-Path -LiteralPath $builder)) {
  throw "electron-builder 不存在，请先执行 npm install: $builder"
}

Push-Location $projectDir
try {
  & $builder --win dir --config.asar=false "--config.directories.output=$relativeOutput"
  if ($LASTEXITCODE -ne 0) {
    throw "electron-builder 失败，退出码: $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

# 构建输出也可能被企业策略重新加密；发布前再次逐文件解密并做 SHA-256 校验。
Invoke-VerifiedDecrypt -Target $outputDir

$appDir = Join-Path $outputDir 'win-unpacked\resources\app'
$exePath = Join-Path $outputDir 'win-unpacked\thiefbook.exe'
$asarPath = Join-Path $outputDir 'win-unpacked\resources\app.asar'
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "发布 EXE 不存在: $exePath"
}
if (-not (Test-Path -LiteralPath $appDir)) {
  throw "明文应用目录不存在: $appDir"
}
if (Test-Path -LiteralPath $asarPath) {
  throw "检测到 app.asar，拒绝交付可能封装密文的构建: $asarPath"
}

$jsFiles = @(
  (Get-Item -LiteralPath (Join-Path $appDir 'main.js')),
  (Get-Item -LiteralPath (Join-Path $appDir 'preload.js'))
) + @(Get-ChildItem -LiteralPath (Join-Path $appDir 'renderer') -Filter '*.js' -File)
foreach ($jsFile in $jsFiles) {
  & node --check $jsFile.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "JavaScript 语法校验失败: $($jsFile.FullName)"
  }
}

if (-not $NoShortcut) {
  $desktopDir = [Environment]::GetFolderPath('Desktop')
  $linkPath = Join-Path $desktopDir 'book.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($linkPath)
  $shortcut.TargetPath = $exePath
  $shortcut.WorkingDirectory = Split-Path -Parent $exePath
  $shortcut.Arguments = ''
  $shortcut.Save()

  $verifiedShortcut = $shell.CreateShortcut($linkPath)
  if ($verifiedShortcut.TargetPath -ne $exePath) {
    throw "桌面快捷方式读回校验失败: $linkPath"
  }
  Write-Host "SHORTCUT_OK $linkPath -> $($verifiedShortcut.TargetPath)"
}

Write-Host "RELEASE_OK version=$version exe=$exePath"
