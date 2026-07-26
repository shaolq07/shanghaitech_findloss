param(
  [string]$GroupIds = $env:QQ_ARCHIVE_GROUP_IDS,
  [string]$WebhookToken = $env:QQ_ARCHIVE_WEBHOOK_TOKEN,
  [int]$Port = 8788,
  [string]$HostAddress = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'

$archiveProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $archiveProjectRoot '..'))
$archiveDataRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'QQ聊天记录'))
$healthUrl = "http://${HostAddress}:${Port}/health"
$lockPath = Join-Path $archiveDataRoot '.qq-archive.lock'

function Get-ArchiveHealth {
  try {
    return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
  } catch {
    return $null
  }
}

$health = Get-ArchiveHealth
if ($health -and $health.service -eq 'lockmyitem-qq-archive') {
  $owner = $null
  if (Test-Path -LiteralPath $lockPath) {
    try {
      $owner = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      $owner = $null
    }
  }
  [pscustomobject]@{
    Started = $false
    Reused = $true
    Pid = $owner.pid
    Url = $healthUrl
    ArchiveRoot = $health.archive_root
  }
  exit 0
}

$portOwner = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($portOwner) {
  throw "端口 $Port 已被 PID $($portOwner.OwningProcess) 占用，但该服务不是 QQ 归档器。"
}

$nodeCommand = Get-Command node -ErrorAction Stop
$serverScript = Join-Path $archiveProjectRoot 'src\server.mjs'
$stdoutPath = Join-Path $archiveDataRoot 'qq-archive.out.log'
$stderrPath = Join-Path $archiveDataRoot 'qq-archive.err.log'

$env:QQ_ARCHIVE_ROOT = $archiveDataRoot
$env:QQ_ARCHIVE_HOST = $HostAddress
$env:QQ_ARCHIVE_PORT = [string]$Port
$env:QQ_ARCHIVE_GROUP_IDS = $GroupIds
$env:QQ_ARCHIVE_WEBHOOK_TOKEN = $WebhookToken

$archiveProcess = Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList "`"$serverScript`"" `
  -WorkingDirectory $archiveProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 200
  if ($archiveProcess.HasExited) { break }
  $health = Get-ArchiveHealth
  if ($health -and $health.service -eq 'lockmyitem-qq-archive') {
    $ready = $true
    break
  }
}

if (-not $ready) {
  if (-not $archiveProcess.HasExited) {
    Stop-Process -Id $archiveProcess.Id -Force -ErrorAction SilentlyContinue
  }
  $errorText = Get-Content -LiteralPath $stderrPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  throw "QQ 归档器启动失败。$errorText"
}

[pscustomobject]@{
  Started = $true
  Reused = $false
  Pid = $archiveProcess.Id
  Url = $healthUrl
  ArchiveRoot = $health.archive_root
}
