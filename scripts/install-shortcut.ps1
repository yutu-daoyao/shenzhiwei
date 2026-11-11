param([string]$DesktopPath = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$entry = Join-Path $root 'open-zhiwei.vbs'
if (!(Test-Path -LiteralPath $entry)) { throw 'Missing open-zhiwei.vbs' }
$shell = New-Object -ComObject WScript.Shell
$destination = Join-Path $DesktopPath ([string][char]0x77E5 + [char]0x5FAE + '.lnk')
$shortcut = $shell.CreateShortcut($destination)
$hostPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$arguments = '"' + $entry + '"'
if ((Test-Path -LiteralPath $destination) -and ($shortcut.TargetPath -ne $hostPath -or $shortcut.Arguments -ne $arguments)) {
    throw 'A different shortcut already uses this name; it was not overwritten.'
}
$shortcut.TargetPath = $hostPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'Open Zhiwei - start automatically, reuse the local service'
$shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',43'
$shortcut.Save()
Write-Output $destination
