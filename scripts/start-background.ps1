param(
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [string]$EntryPath = (Join-Path $PSScriptRoot '..\src\main.js')
)
$ErrorActionPreference = 'Stop'
# Node stays resident after this launcher exits. No console window is created.
Start-Process -FilePath $NodePath -ArgumentList ('"' + $EntryPath + '"') -WorkingDirectory (Split-Path (Split-Path $EntryPath)) -WindowStyle Hidden
