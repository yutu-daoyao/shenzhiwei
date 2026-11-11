# Offline test: extract the dispatcher only, with fake desktop/Target functions.
# No UIAutomation assembly, Win32 type, real desktop check or app is loaded.
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '../../src/windows/worker.ps1'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'worker syntax invalid'}
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Operation'},$true)
. ([scriptblock]::Create($definition.Extent.Text))
function Require-Desktop {}
function Target($id) {if($owned[$id].marker -eq 'invalid'){throw 'WINDOW_CHANGED'};return $null}
$owned=@{'7'=@{id='7';marker='original'}};$rejected=0
foreach($id in @('7','8')) {
  try {[void](Invoke-Operation 'register_windows' @{windows=@(@{id=$id;marker='invalid'})})}
  catch {$rejected++}
}
[void](Invoke-Operation 'register_windows' @{windows=@(@{id='9';marker='valid'})})
@{rejected=$rejected;oldPreserved=($owned['7'].marker -eq 'original');newRemoved=(-not $owned.ContainsKey('8'));validAdded=$owned.ContainsKey('9')} | ConvertTo-Json -Compress
