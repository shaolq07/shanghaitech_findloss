param(
  [string]$ShellRoot,
  [string]$QuickLoginUin = ''
)

$ErrorActionPreference = 'Stop'

$archiveProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $archiveProjectRoot '..'))
if (-not $ShellRoot) {
  $ShellRoot = Join-Path $workspaceRoot '_runtime\napcat\NapCat.49738.Shell'
}
$ShellRoot = [IO.Path]::GetFullPath($ShellRoot)

$bootPath = Join-Path $ShellRoot 'NapCatWinBootMain.exe'
$qqPath = Join-Path $ShellRoot 'QQ.exe'
$hookPath = Join-Path $ShellRoot 'NapCatWinBootHook.dll'
$versionDirectory = Get-ChildItem -LiteralPath (Join-Path $ShellRoot 'versions') -Directory |
  Sort-Object Name -Descending |
  Select-Object -First 1
if (-not $versionDirectory) {
  throw "NapCat 运行目录中没有 QQ 版本：$ShellRoot"
}
$napcatRoot = Join-Path $versionDirectory.FullName 'resources\app\napcat'
$patchPackagePath = Join-Path $napcatRoot 'qqnt.json'
$loadPath = Join-Path $napcatRoot 'loadNapCat.js'
$mainPath = Join-Path $napcatRoot 'napcat.mjs'
foreach ($requiredPath in @(
  $bootPath,
  $qqPath,
  $hookPath,
  $patchPackagePath,
  $loadPath,
  $mainPath
)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "NapCat 运行文件不存在：$requiredPath"
  }
}

function Test-InShellRoot {
  param([string]$Path)
  if (-not $Path) { return $false }
  return [IO.Path]::GetFullPath($Path).StartsWith(
    $ShellRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Test-ProcessInShellRoot {
  param($Process)
  if ($Process.ExecutablePath -and (Test-InShellRoot -Path $Process.ExecutablePath)) {
    return $true
  }
  return [bool](
    $Process.CommandLine -and
    $Process.CommandLine.IndexOf($ShellRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
  )
}

$existingBoot = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'NapCatWinBootMain.exe' -and
    (Test-ProcessInShellRoot -Process $_)
  } |
  Select-Object -First 1
if ($existingBoot) {
  [pscustomobject]@{
    Started = $false
    Reused = $true
    BootPid = $existingBoot.ProcessId
    ShellRoot = $ShellRoot
    WebUi = 'http://127.0.0.1:6099'
  }
  exit 0
}

$ordinaryQq = Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" |
  Where-Object {
    $_.CommandLine -notmatch '--type=' -and
    -not (Test-ProcessInShellRoot -Process $_)
  }
if ($ordinaryQq) {
  $processIds = ($ordinaryQq.ProcessId -join ', ')
  throw "检测到普通 QQ 主进程（PID $processIds）。请先彻底退出，避免同号重复登录。"
}

$portOwner = Get-NetTCPConnection -State Listen -LocalPort 6099 -ErrorAction SilentlyContinue
if ($portOwner) {
  throw "NapCat WebUI 端口 6099 已被 PID $($portOwner.OwningProcess) 占用。"
}

$arguments = "`"$qqPath`" `"$hookPath`""
if ($QuickLoginUin) {
  if ($QuickLoginUin -notmatch '^\d+$') {
    throw 'QuickLoginUin 必须只包含数字。'
  }
  $arguments += " $QuickLoginUin"
}

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $bootPath
$startInfo.Arguments = $arguments
$startInfo.WorkingDirectory = $ShellRoot
$startInfo.UseShellExecute = $false
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.EnvironmentVariables['NAPCAT_PATCH_PACKAGE'] = $patchPackagePath
$startInfo.EnvironmentVariables['NAPCAT_LOAD_PATH'] = $loadPath
$startInfo.EnvironmentVariables['NAPCAT_INJECT_PATH'] = $hookPath
$startInfo.EnvironmentVariables['NAPCAT_LAUNCHER_PATH'] = $bootPath
$startInfo.EnvironmentVariables['NAPCAT_MAIN_PATH'] = $mainPath
$bootProcess = [Diagnostics.Process]::Start($startInfo)

$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  if ($bootProcess.HasExited) { break }
  $listener = Get-NetTCPConnection -State Listen -LocalPort 6099 -ErrorAction SilentlyContinue
  if ($listener) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  if (-not $bootProcess.HasExited) {
    Stop-Process -Id $bootProcess.Id -Force -ErrorAction SilentlyContinue
  }
  throw 'NapCat 启动失败：20 秒内未监听 WebUI 端口 6099。'
}

[pscustomobject]@{
  Started = $true
  Reused = $false
  BootPid = $bootProcess.Id
  ShellRoot = $ShellRoot
  WebUi = 'http://127.0.0.1:6099'
}
