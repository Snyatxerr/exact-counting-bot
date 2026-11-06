$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$secret = Read-Host 'Discord Bot Token（非表示入力。チャットへ貼らない）' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  [IO.File]::WriteAllText((Join-Path $project '.dev.vars'), "DISCORD_BOT_TOKEN=$plain`n", [Text.UTF8Encoding]::new($false))
  Write-Host '.dev.varsへ保存しました（Git対象外）。本番への登録はデプロイ時に行います。'
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $plain = $null }
