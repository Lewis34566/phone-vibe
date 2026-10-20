# 手机版 Agent —— 公网模式：本机跑服务 + Cloudflare 隧道，生成一个 https 网址
# 用法：右键“使用 PowerShell 运行”，或在 PowerShell 里执行 .\start-public.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$tokenFile = Join-Path $PSScriptRoot '.public-token'
if (Test-Path $tokenFile) {
  $token = (Get-Content $tokenFile -Raw).Trim()
} else {
  $chars = (48..57) + (65..90) + (97..122)
  $token = -join ($chars | Get-Random -Count 8 | ForEach-Object { [char]$_ })
  Set-Content -Path $tokenFile -Value $token -Encoding ASCII
}
$env:ACCESS_TOKEN = $token

if (-not (Test-Path (Join-Path $PSScriptRoot 'cloudflared.exe'))) {
  Write-Host ''
  Write-Host '缺少 cloudflared.exe（公网隧道工具，只需下载一次）' -ForegroundColor Yellow
  Write-Host '下载地址：'
  Write-Host '  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Write-Host '下载后把文件改名为 cloudflared.exe，放进本文件夹，再运行一次这个脚本。'
  Write-Host ''
  exit 1
}

Write-Host ''
Write-Host "访问密码：$token" -ForegroundColor Green
Write-Host '（别人打开网址后，用户名随便填，密码填这个）' -ForegroundColor DarkGray
Write-Host '正在启动本机服务…' -ForegroundColor Cyan
Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot
Start-Sleep -Seconds 3
Write-Host '正在建立公网隧道，稍等几秒，下面的 https 地址就是公网访问地址：' -ForegroundColor Cyan
Write-Host ''
& (Join-Path $PSScriptRoot 'cloudflared.exe') tunnel --url http://127.0.0.1:8787
