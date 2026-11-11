# Isolated verification/dispatch test. No desktop or native Win32 function is called.
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../../src/windows/worker.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'worker syntax invalid'}
$native=($tokens | Where-Object {$_.Kind -eq 'HereStringLiteral'} | Select-Object -First 1).Value
Add-Type -TypeDefinition ($native.Replace('class ZhiweiNative','class ZhiweiNativeCompileCheck'))
Add-Type -TypeDefinition @'
public static class ZhiweiNative {
 public static int Reads;public static bool Wrong;
 public static bool FileNameMatches(System.IntPtr edit,string text){Reads++;return !Wrong&&Reads>=3;}
}
'@
foreach($name in @('Verify-FileName','Invoke-Operation')) {
  $node=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  . ([scriptblock]::Create($node.Extent.Text))
}
$script:Locked=$false
function Require-Desktop {if($script:Locked){throw 'DESKTOP_LOCKED'}}
Verify-FileName ([IntPtr]1) 'expected'
$delayed=([ZhiweiNative]::Reads -eq 3)
[ZhiweiNative]::Reads=0;[ZhiweiNative]::Wrong=$true;$rejected=$false
try {Verify-FileName ([IntPtr]1) 'expected'}catch {$rejected=$_.Exception.Message -match 'FILENAME_INPUT_NOT_VERIFIED'}
$script:Locked=$true;[ZhiweiNative]::Reads=0;$lockRejected=$false
try {Verify-FileName ([IntPtr]1) 'expected'}catch {$lockRejected=$_.Exception.Message -eq 'DESKTOP_LOCKED'}
$noRead=([ZhiweiNative]::Reads -eq 0)
$script:Locked=$false;$script:Cancelled=0
$script:Root=[pscustomobject]@{Current=[pscustomobject]@{IsEnabled=$false}}
function Target($id){return $script:Root}
function Window-Info($root){return @{id='1';enabled=$root.Current.IsEnabled}}
function Cancel-SaveDialog($root){$script:Cancelled++;$root.Current.IsEnabled=$true}
$cancel=Invoke-Operation 'send_keys' @{windowId='1';key='Escape'}
$script:Root.Current.IsEnabled=$false;$otherBlocked=$false
try {[void](Invoke-Operation 'send_keys' @{windowId='1';key='Enter'})}catch{$otherBlocked=$_.Exception.Message -match 'MODAL_BLOCKING'}
@{delayedMatch=$delayed;wrongRejected=$rejected;lockedRejected=$lockRejected;noReadWhileLocked=$noRead;cancelRouted=($cancel.cancelledSaveDialog -and $script:Cancelled -eq 1);otherKeyBlocked=$otherBlocked} | ConvertTo-Json -Compress
