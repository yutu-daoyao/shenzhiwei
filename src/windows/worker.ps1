param()
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase,System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class ZhiweiNative {
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h,EnumProc p,IntPtr l);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
 public static bool IsFileNameEdit(IntPtr edit,IntPtr dialog) {
   if(GetDlgCtrlID(edit)==1152)return true; // Legacy common-dialog edt1.
   for(IntPtr parent=GetParent(edit);parent!=IntPtr.Zero&&parent!=dialog;parent=GetParent(parent)) {
     var name=new StringBuilder(100);GetClassName(parent,name,100);
     if(GetDlgCtrlID(parent)==1148&&(name.ToString()=="ComboBox"||name.ToString()=="ComboBoxEx32"))return true;
   }
   return false;
 }
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 public static IntPtr ChildIdClass(IntPtr root,int id,string name) {IntPtr found=IntPtr.Zero;EnumChildWindows(root,delegate(IntPtr h,IntPtr l){var b=new StringBuilder(100);GetClassName(h,b,100);if(GetDlgCtrlID(h)==id&&b.ToString()==name&&IsWindowVisible(h)&&IsWindowEnabled(h)){found=h;return false;}return true;},IntPtr.Zero);return found;}
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW",SetLastError=true)] public static extern IntPtr SendMessageTimeoutRead(IntPtr h,uint m,IntPtr w,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
 public static bool FileNameMatches(IntPtr edit,string text) {
   UIntPtr result;var b=new StringBuilder(32768);return SendMessageTimeoutRead(edit,13,(IntPtr)b.Capacity,b,2,150,out result)!=IntPtr.Zero&&b.ToString()==text;
 }
 public static IntPtr[] Windows() { var list=new List<IntPtr>(); EnumWindows(delegate(IntPtr h,IntPtr l){if(IsWindowVisible(h))list.Add(h);return true;},IntPtr.Zero); return list.ToArray(); }
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread,ref GUIINFO info);
 [StructLayout(LayoutKind.Sequential)] public struct GUIINFO {public uint size,flags;public IntPtr active,focus,capture,menuOwner,moveSize,caret;public RECT caretRect;}
 public static void FocusFileName(IntPtr dialog,IntPtr edit) {
   if(GetForegroundWindow()!=dialog||!IsWindowVisible(edit)||!IsWindowEnabled(edit))throw new Exception("FILENAME_TARGET_NOT_READY");
   uint pid;uint target=GetWindowThreadProcessId(edit,out pid),current=GetCurrentThreadId();
   bool attached=current!=target&&AttachThreadInput(current,target,true);
   try {SetFocus(edit);}finally {if(attached)AttachThreadInput(current,target,false);}
   var info=new GUIINFO();info.size=(uint)Marshal.SizeOf(typeof(GUIINFO));
   if(GetForegroundWindow()!=dialog||!GetGUIThreadInfo(0,ref info)||info.focus!=edit)throw new Exception("FILENAME_FOCUS_NOT_VERIFIED");
 }
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);
 public static void Focus(IntPtr window) {
   uint pid; uint target=GetWindowThreadProcessId(window,out pid); uint current=GetCurrentThreadId();
   uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out pid);
   try { AttachThreadInput(current,foreground,true); AttachThreadInput(current,target,true); SetForegroundWindow(window); }
   finally { AttachThreadInput(current,target,false); AttachThreadInput(current,foreground,false); }
 }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr d,uint f);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint f);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 public static void Wheel(int delta) { mouse_event(0x800,0,0,unchecked((uint)delta),UIntPtr.Zero); }
 public struct RECT { public int Left,Top,Right,Bottom; }
 public struct POINT { public int X,Y; public POINT(int x,int y){X=x;Y=y;} }
 [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MI { public int x,y; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] public struct IU { [FieldOffset(0)] public KI keyboard; [FieldOffset(0)] public MI mouse; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public IU input; }
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,INPUT[] input,int size);
 public static void TypeUnicode(string text,IntPtr window) {
   if(GetForegroundWindow()!=window) throw new Exception("FOCUS_CHANGED");
   var input=new INPUT[text.Length*2];
   for(int i=0;i<text.Length;i++) {
     input[i*2].type=1; input[i*2].input.keyboard.scan=text[i]; input[i*2].input.keyboard.flags=4;
     input[i*2+1]=input[i*2]; input[i*2+1].input.keyboard.flags=6;
   }
   if(SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)))!=input.Length) throw new Exception("INPUT_PARTIAL_RESULT_UNKNOWN");
 }
}
'@
try { [void][ZhiweiNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
$uia = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$owned = @{}
$snapshots = @{}
function Desktop-Status {
  $foreground=[ZhiweiNative]::GetForegroundWindow();$processId=[uint32]0
  [void][ZhiweiNative]::GetWindowThreadProcessId($foreground,[ref]$processId)
  $name=$null;try {$name=(Get-Process -Id $processId -ErrorAction Stop).ProcessName} catch {}
  return @{locked=($foreground -eq [IntPtr]::Zero -or $name -match '^(LockApp|LogonUI|CredentialUIBroker|consent)$');observedAt=[DateTime]::UtcNow.ToString('o')}
}
function Require-Desktop {
  if((Desktop-Status).locked) {throw 'DESKTOP_LOCKED: Windows is locked or on a secure desktop. The user must unlock it; no action was performed. Do not retry or bypass.'}
}

function Window-Info($element) {
  $c = $element.Current
  $started=(Get-Process -Id $c.ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
  $r=New-Object ZhiweiNative+RECT; [void][ZhiweiNative]::GetWindowRect([IntPtr]$c.NativeWindowHandle,[ref]$r)
  [ordered]@{ id=[string]$c.NativeWindowHandle; pid=$c.ProcessId; processStartedAt=$started; title=$c.Name; className=$c.ClassName; enabled=$c.IsEnabled; offscreen=$c.IsOffscreen; active=([ZhiweiNative]::GetForegroundWindow().ToInt64() -eq $c.NativeWindowHandle); bounds=@{x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top} }
}
function Windows {
  $list = New-Object System.Collections.Generic.List[object]
  foreach($h in [ZhiweiNative]::Windows()) {
    try { $e=$uia::FromHandle($h); if ($e.Current.NativeWindowHandle -ne 0 -and -not $e.Current.IsOffscreen) { $list.Add((Window-Info $e)) } } catch {}
    if($list.Count -ge 100) {break}
  }
  return ,@($list.ToArray())
}
function Target($id) {
  if (-not $owned.ContainsKey([string]$id)) { throw 'WINDOW_NOT_OWNED: only a newly launched test window is controllable' }
  $window = $owned[[string]$id]
  if (-not [ZhiweiNative]::IsWindow([IntPtr]([long]$id))) { throw 'WINDOW_CLOSED' }
  $e = $uia::FromHandle([IntPtr]([long]$id))
  $started=(Get-Process -Id $e.Current.ProcessId).StartTime.ToUniversalTime().ToString('o')
  if ($e.Current.ProcessId -ne $window.pid -or $e.Current.ClassName -ne $window.className -or $started -ne $window.processStartedAt) { throw 'WINDOW_CHANGED: handle identity changed' }
  if($window.app -eq 'notepad') {
    if($window.tabRuntimeId) {
      $selected=Selected-Tab $e
      if($null -eq $selected -or ($selected.GetRuntimeId() -join ',') -ne $window.tabRuntimeId) {throw 'ACTIVE_DOCUMENT_CHANGED: selected tab identity changed'}
    } elseif(-not $e.Current.Name.Contains($window.documentName)) {throw 'ACTIVE_DOCUMENT_CHANGED: no input or document read allowed'}
  }
  return $e
}
function Selected-Tab($root) {
  $tabs=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)))
  foreach($tab in $tabs) { $pattern=$null; if($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern) -and $pattern.Current.IsSelected) {return $tab} }
  return $null
}
function Foreground($root) {
  $h = [IntPtr]$root.Current.NativeWindowHandle
  [void][ZhiweiNative]::ShowWindow($h,9)
  try {$root.SetFocus()} catch {}
  [ZhiweiNative]::Focus($h)
  Start-Sleep -Milliseconds 100
  if ([ZhiweiNative]::GetForegroundWindow() -ne $h) { throw 'FOCUS_FAILED: no keyboard or mouse input sent' }
}
function Tree($root,$windowId) {
  $items = New-Object System.Collections.Generic.List[object]
  $token = [guid]::NewGuid().ToString('N')
  $map = @{}
  function Visit($element,$depth,$parent) {
    if ($depth -gt 6 -or $items.Count -ge 180) { return }
    try {
      $c = $element.Current
      if ($c.IsPassword) { return }
      if ($c.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and $owned[[string]$windowId].app -eq 'notepad' -and ($element.GetRuntimeId() -join ',') -ne $owned[[string]$windowId].tabRuntimeId) { return }
      if ($c.AutomationId -in @('SettingsButton','FREButton','CloseButton')) { return }
      $key = [string]$items.Count
      $patterns = @($element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName.Replace('PatternIdentifiers.Pattern','') })
      $text = $null
      $pat = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pat)) { $text = $pat.Current.Value }
      elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pat)) { $text = $pat.DocumentRange.GetText(20000) }
      $rid = ($element.GetRuntimeId() -join ',')
      $row = [ordered]@{ elementId=$key; parent=$parent; depth=$depth; name=$c.Name; type=$c.ControlType.ProgrammaticName.Replace('ControlType.',''); automationId=$c.AutomationId; enabled=$c.IsEnabled; offscreen=$c.IsOffscreen; patterns=$patterns; text=$text }
      $items.Add($row)
      $map[$key] = @{ rid=$rid; name=$c.Name; type=$c.ControlType.Id; automationId=$c.AutomationId }
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child -and $items.Count -lt 180) { Visit $child ($depth+1) $key; $child=$walker.GetNextSibling($child) }
    } catch {}
  }
  Visit $root 0 $null
  $snapshots.Clear()
  $snapshots[$token] = @{ windowId=[string]$windowId; at=[DateTime]::UtcNow; elements=$map }
  return @{ snapshot=$token; at=[DateTime]::UtcNow.ToString('o'); window=(Window-Info $root); elements=@($items.ToArray()); bounded=$true }
}
function Element($root,$p) {
  if (-not $snapshots.ContainsKey([string]$p.snapshot)) { throw 'STALE_SNAPSHOT: obtain a fresh UI tree' }
  $snapshot=$snapshots[[string]$p.snapshot]
  if ($snapshot.windowId -ne [string]$p.windowId -or ([DateTime]::UtcNow-$snapshot.at).TotalSeconds -gt 120) { throw 'STALE_SNAPSHOT' }
  $old=$snapshot.elements[[string]$p.elementId]
  if ($null -eq $old) { throw 'ELEMENT_NOT_FOUND' }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($e in $all) {
    try {
      $c=$e.Current
      if (($e.GetRuntimeId() -join ',') -eq $old.rid) {
        if ($c.AutomationId -in @('SettingsButton','FREButton','CloseButton') -or $c.Name -match '(?i)close|delete|settings|\u5173\u95ed|\u5220\u9664|\u8bbe\u7f6e') { throw 'ELEMENT_CHANGED' }
        if ($c.IsPassword -or -not $c.IsEnabled -or $c.Name -ne $old.name -or $c.ControlType.Id -ne $old.type -or $c.AutomationId -ne $old.automationId) { throw 'ELEMENT_CHANGED' }
        return $e
      }
    } catch { if ($_.Exception.Message -eq 'ELEMENT_CHANGED') { throw } }
  }
  throw 'ELEMENT_CHANGED: refresh UI tree; action not executed'
}
function Read-Text($root) {
  if($root.Current.ClassName -eq 'Notepad' -or $owned[[string]$root.Current.NativeWindowHandle].app -eq 'browser') {
    $all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document)))
  } else { $all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition) }
  $result=New-Object System.Collections.Generic.List[object]
  foreach($e in $all) {
    if ($result.Count -ge 40) { break }
    try {
      if ($e.Current.IsPassword) { continue }
      $p=$null; $value=$null
      if ($e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$p)) { $value=$p.DocumentRange.GetText(30000) }
      elseif ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$p)) { $value=$p.Current.Value }
      if ($value) { $result.Add(@{name=$e.Current.Name;automationId=$e.Current.AutomationId;text=$value}) }
    } catch {}
  }
  return ,@($result.ToArray())
}
function Verify-FileName($edit,$expected) {
  # SendInput queues input; a synchronous WM_GETTEXT may overtake the queued keys.
  # Observe until exact match, never repeat input or press Save on a partial value.
  $deadline=[DateTime]::UtcNow.AddSeconds(3)
  do {
    Require-Desktop
    if([ZhiweiNative]::FileNameMatches($edit,[string]$expected)) {return}
    Start-Sleep -Milliseconds 25
  } while([DateTime]::UtcNow -lt $deadline)
  throw 'FILENAME_INPUT_NOT_VERIFIED: Save was not clicked'
}
function Find-SaveDialog($root) {
  Require-Desktop
  foreach($handle in [ZhiweiNative]::Windows()) {
    $ownerProcess=[uint32]0;[void][ZhiweiNative]::GetWindowThreadProcessId($handle,[ref]$ownerProcess)
    if($ownerProcess -ne $root.Current.ProcessId){continue}
    $dialog=$uia::FromHandle($handle)
    if($dialog.Current.ClassName -ne '#32770' -or $dialog.Current.ProcessId -ne $root.Current.ProcessId -or [ZhiweiNative]::GetAncestor($handle,3) -ne [IntPtr]$root.Current.NativeWindowHandle -or $dialog.Current.Name -notmatch '(?i)save as|\u53e6\u5b58\u4e3a') {continue}
    $combo=[ZhiweiNative]::ChildIdClass($handle,1148,'ComboBoxEx32')
    if($combo -eq [IntPtr]::Zero){$combo=[ZhiweiNative]::ChildIdClass($handle,1148,'ComboBox')}
    $edit=[IntPtr]::Zero
    if($combo -ne [IntPtr]::Zero){$edit=[ZhiweiNative]::ChildIdClass($combo,1001,'Edit')}
    if($edit -eq [IntPtr]::Zero){$edit=[ZhiweiNative]::ChildIdClass($handle,1152,'Edit')}
    if($edit -eq [IntPtr]::Zero){$edit=[ZhiweiNative]::ChildIdClass($handle,1001,'Edit')}
    if($edit -ne [IntPtr]::Zero){
      $field=$uia::FromHandle($edit)
      if([ZhiweiNative]::IsFileNameEdit($edit,$handle) -or $field.Current.Name -match '(?i)file\s*name|\u6587\u4ef6\u540d'){return @{window=$dialog;edit=$edit}}
    }
  }
  return $null
}
function Cancel-SaveDialog($root) {
  $match=Find-SaveDialog $root
  if($null -eq $match){throw 'SAVE_DIALOG_NOT_FOUND: no matching owned Save As dialog'}
  $buttonHandle=[ZhiweiNative]::ChildIdClass([IntPtr]$match.window.Current.NativeWindowHandle,2,'Button')
  if($buttonHandle -eq [IntPtr]::Zero){throw 'SAVE_DIALOG_CANCEL_UNAVAILABLE'}
  Require-Desktop
  $button=$uia::FromHandle($buttonHandle);$invoke=$null
  if($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)){$invoke.Invoke()}
  else{[void][ZhiweiNative]::PostMessage($buttonHandle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)}
  $deadline=[DateTime]::UtcNow.AddSeconds(2)
  do {Require-Desktop;if($null -eq (Find-SaveDialog $root)){return};Start-Sleep -Milliseconds 50}while([DateTime]::UtcNow -lt $deadline)
  throw 'SAVE_DIALOG_CANCEL_UNKNOWN: dialog is still present; do not replay'
}
function Invoke-Operation($op,$p) {
  if($op -eq 'desktop_status') {return (Desktop-Status)}
  Require-Desktop
  if($op -eq 'inspect_binding') {
    $key=[string]$p.window.id;$had=$owned.ContainsKey($key);$previous=$owned[$key]
    try {$owned[$key]=$p.window;$restored=Target $key;return @{window=(Window-Info $restored)}}
    finally {if($had){$owned[$key]=$previous}else{$owned.Remove($key)}}
  }
  if ($op -eq 'register_windows') {
    foreach($w in $p.windows) {
      $key=[string]$w.id;$had=$owned.ContainsKey($key);$previous=$owned[$key]
      try {$owned[$key]=$w;[void](Target $key)}
      catch {if($had){$owned[$key]=$previous}else{$owned.Remove($key)};throw}
    }
    return @{registered=$owned.Count}
  }
  if ($op -eq 'list_windows') { return @{windows=(Windows)} }
  if ($op -eq 'launch_app') {
    $before=@((Windows) | ForEach-Object {$_.id})
    switch($p.app) {
      'notepad' { $exe=Join-Path $env:WINDIR 'System32/notepad.exe'; Start-Process -FilePath $exe -ArgumentList ('"'+$p.documentPath+'"') | Out-Null }
      'calculator' { Start-Process -FilePath (Join-Path $env:WINDIR 'System32/calc.exe') | Out-Null }
      'explorer' { Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('"'+$p.workspace+'"') | Out-Null }
      'browser' {
        $command=Get-Command msedge -ErrorAction SilentlyContinue
        $exe=if($command){$command.Source}else{$null}
        if(-not $exe) {
          foreach($base in @(${env:ProgramFiles(x86)},$env:ProgramFiles)) {
            if($base) {$candidate=Join-Path $base 'Microsoft\Edge\Application\msedge.exe';if(Test-Path $candidate){$exe=$candidate;break}}
          }
        }
        if(-not $exe) {throw 'BROWSER_NOT_FOUND: Microsoft Edge is not installed'}
        Start-Process -FilePath $exe -ArgumentList ('--new-window --no-first-run --user-data-dir="'+$p.profileDir+'" "'+$p.url+'"') | Out-Null
      }
      default { throw 'APP_NOT_ALLOWED' }
    }
    $deadline=[DateTime]::UtcNow.AddSeconds(12)
    do {
      Start-Sleep -Milliseconds 250
      foreach($w in (Windows)) {
        $process=Get-Process -Id $w.pid -ErrorAction SilentlyContinue
        $match=($p.app -eq 'notepad' -and ($process.ProcessName -match 'notepad') -and $w.title.Contains([IO.Path]::GetFileName($p.documentPath))) -or ($p.app -eq 'calculator' -and $process.ProcessName -match 'Calculator|ApplicationFrameHost' -and $w.title -match '(?i)calculator|\u8ba1\u7b97\u5668') -or ($p.app -eq 'explorer' -and $process.ProcessName -eq 'explorer' -and $w.title.Contains([IO.Path]::GetFileName($p.workspace)))
        $match=$match -or ($p.app -eq 'browser' -and $process.ProcessName -eq 'msedge' -and $w.className -eq 'Chrome_WidgetWin_1')
        if($match -and $p.app -eq 'notepad') {
          $candidate=$uia::FromHandle([IntPtr]([long]$w.id))
          $tabs=$candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)))
          if(($before -contains $w.id) -or $tabs.Count -gt 1) {
            # Only the just-opened UUID test tab is active. Ctrl+Shift+N creates a separate window;
            # no existing document is edited, selected, closed or saved.
            $prior=@((Windows)|ForEach-Object {$_.id})
            $fileMenu=$candidate.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($uia::AutomationIdProperty,'File')))
            if($null -eq $fileMenu) {throw 'NOTEPAD_FILE_MENU_UNAVAILABLE'}
            $fileMenu.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
            Start-Sleep -Milliseconds 200
            $menuItems=$candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty,[System.Windows.Automation.ControlType]::MenuItem)))
            $newMenu=$null
            foreach($menu in $menuItems) {if($menu.Current.Name -match '(?i)new window|\u65b0\u5efa\u7a97\u53e3|\u65b0\u7a97\u53e3') {$newMenu=$menu;break}}
            if($null -eq $newMenu) {throw ('NEW_WINDOW_MENU_UNAVAILABLE: '+(($menuItems|ForEach-Object {$_.Current.Name}) -join '|'))}
            $newMenu.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            $new=$null; $until=[DateTime]::UtcNow.AddSeconds(5)
            do {Start-Sleep -Milliseconds 150; $new=@((Windows)|Where-Object { $prior -notcontains $_.id -and $_.className -eq 'Notepad' -and $_.pid -eq $w.pid })|Select-Object -First 1} while($null -eq $new -and [DateTime]::UtcNow -lt $until)
            if($null -eq $new) {throw 'ISOLATED_NOTEPAD_WINDOW_UNAVAILABLE'}
            $candidate=$uia::FromHandle([IntPtr]([long]$new.id))
            $w=Window-Info $candidate
            if($candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem))).Count -gt 1) {throw 'ISOLATED_WINDOW_HAS_UNRELATED_TABS'}
            $w.documentName=$w.title.Replace(' - Notepad','').TrimStart('*')
          }
        } elseif($before -contains $w.id) { continue }
        if($match) { $w.app=$p.app; if(-not $w.documentName) {$w.documentName=[IO.Path]::GetFileName($p.documentPath)}; if($p.app -eq 'notepad') {$tab=Selected-Tab ($uia::FromHandle([IntPtr]([long]$w.id)));if($null -ne $tab){$w.tabRuntimeId=($tab.GetRuntimeId() -join ',')}}; $owned[$w.id]=$w; return @{window=$w;app=$p.app;documentPath=$p.documentPath} }
      }
    } while([DateTime]::UtcNow -lt $deadline)
    throw 'NEW_WINDOW_NOT_FOUND: existing user windows were not adopted'
  }
  $root=Target $p.windowId
  if ($op -eq 'get_window') { return @{window=(Window-Info $root)} }
  if(-not $root.Current.IsEnabled) {
    if($op -eq 'send_keys' -and $p.key -eq 'Escape') {
      Cancel-SaveDialog $root
      return @{cancelledSaveDialog=$true;documentPreserved=$true;window=(Window-Info $root);source='UIAutomation.CancelOwnedSaveDialog'}
    }
    throw 'MODAL_BLOCKING: generic controls and capture blocked; use the bounded file-dialog workflow'
  }
  if($op -eq 'describe_element') { $e=Element $root $p; return @{name=$e.Current.Name;type=$e.Current.ControlType.ProgrammaticName;automationId=$e.Current.AutomationId;window=(Window-Info $root)} }
  if ($op -eq 'get_ui_tree' -or $op -eq 'find_element') { return (Tree $root $p.windowId) }
  if ($op -eq 'read_text') { return @{window=(Window-Info $root);observedAt=[DateTime]::UtcNow.ToString('o');texts=(Read-Text $root);source='UIAutomation'} }
  if ($op -eq 'focus_window') { Foreground $root; return @{window=(Window-Info $root)} }
  if ($op -eq 'close_window') { [void][ZhiweiNative]::PostMessage([IntPtr]([long]$p.windowId),0x10,[IntPtr]::Zero,[IntPtr]::Zero); return @{requested=$true;closed=(-not [ZhiweiNative]::IsWindow([IntPtr]([long]$p.windowId)));note='A save prompt may remain; no discard is automatic'} }
  if ($op -eq 'click_element' -or $op -eq 'select_element' -or $op -eq 'set_text') {
    $e=Element $root $p; $pattern=$null
    if($op -eq 'click_element') {
      Require-Desktop
      if(-not $e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { throw 'UIA_INVOKE_UNSUPPORTED: no coordinate click was substituted' }
      $pattern.Invoke()
    } elseif($op -eq 'select_element') {
      Require-Desktop
      if(-not $e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) { throw 'UIA_SELECTION_UNSUPPORTED' }
      $pattern.Select()
    } else {
      Require-Desktop
      if($root.Current.ClassName -ne 'Notepad' -or $e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document) {throw 'TEXT_INPUT_SCOPE_DENIED: only the test Notepad document is editable'}
      if($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern) -and -not $pattern.Current.IsReadOnly) { $pattern.SetValue([string]$p.text) }
      else {
        if($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document -and $e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { throw 'UIA_EDIT_UNSUPPORTED' }
        Foreground $root; $e.SetFocus()
        if(([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join ',') -ne ($e.GetRuntimeId() -join ',')) { throw 'FOCUS_FAILED' }
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        [ZhiweiNative]::TypeUnicode([string]$p.text,[IntPtr]([long]$p.windowId))
      }
    }
    return @{window=(Window-Info $root);verifiedTexts=(Read-Text $root);action=$op}
  }
  if($op -eq 'send_keys') { Foreground $root; [System.Windows.Forms.SendKeys]::SendWait([string]$p.keys); return @{window=(Window-Info $root);sent=$p.keys} }
  if($op -eq 'mouse') {
    Foreground $root
    $r=New-Object ZhiweiNative+RECT; [void][ZhiweiNative]::GetWindowRect([IntPtr]([long]$p.windowId),[ref]$r)
    $x=$r.Left+[int]$p.x; $y=$r.Top+[int]$p.y
    if($x -lt $r.Left -or $x -ge $r.Right -or $y -lt $r.Top -or $y -ge $r.Bottom) { throw 'COORDINATE_OUTSIDE_WINDOW' }
    $hit=[ZhiweiNative]::WindowFromPoint((New-Object ZhiweiNative+POINT($x,$y)))
    if([ZhiweiNative]::GetAncestor($hit,2) -ne [IntPtr]([long]$p.windowId)) { throw 'WINDOW_OCCLUDED: no input sent' }
    [void][ZhiweiNative]::SetCursorPos($x,$y)
    if($p.kind -eq 'scroll') { [ZhiweiNative]::Wheel([int]$p.delta) }
    else { for($i=0;$i -lt [int]$p.count;$i++) { [ZhiweiNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [ZhiweiNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero) } }
    return @{window=(Window-Info $root);x=$x;y=$y;coordinateSpace='physical-screen-pixels';action=$p.kind}
  }
  if($op -eq 'save_notepad') {
    $doc=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document)))
    $expected=$null;$value=$null
    if($null -ne $doc -and $doc.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value)) {$expected=$value.Current.Value}
    if($null -eq $expected) {throw 'SAVE_SOURCE_UNREADABLE: no verified document text'}
    return @{expectedText=$expected;observedAt=[DateTime]::UtcNow.ToString('o');window=(Window-Info $root);source='UIAutomation.ValuePattern'}
  }
  if($op -eq 'capture_window') {
    if($owned[[string]$p.windowId].app -eq 'notepad') {
      $tabs=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)))
      foreach($tab in $tabs) { if(($tab.GetRuntimeId() -join ',') -ne $owned[[string]$p.windowId].tabRuntimeId) {throw 'CAPTURE_BLOCKED: unrelated restored tabs are present; no screenshot collected'} }
    }
    if($root.Current.IsOffscreen) {throw 'CAPTURE_UNAVAILABLE: window minimized'}
    $r=New-Object ZhiweiNative+RECT; [void][ZhiweiNative]::GetWindowRect([IntPtr]([long]$p.windowId),[ref]$r)
    $width=$r.Right-$r.Left; $height=$r.Bottom-$r.Top
    if($width -lt 1 -or $height -lt 1 -or $width*$height -gt 12000000) {throw 'CAPTURE_SIZE_UNSUPPORTED'}
    $bitmap=New-Object System.Drawing.Bitmap($width,$height); $g=[System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $dc=$g.GetHdc()
      try { if(-not [ZhiweiNative]::PrintWindow([IntPtr]([long]$p.windowId),$dc,2)) {throw 'CAPTURE_UNAVAILABLE: PrintWindow failed; no screen-wide fallback'} } finally {$g.ReleaseHdc($dc)}
      $first=$bitmap.GetPixel(0,0).ToArgb();$varied=$false
      for($sx=0;$sx -lt $width;$sx+=[Math]::Max(1,[int]($width/30))) {for($sy=0;$sy -lt $height;$sy+=[Math]::Max(1,[int]($height/30))) {if($bitmap.GetPixel($sx,$sy).ToArgb() -ne $first) {$varied=$true;break}}}
      if(-not $varied) {throw 'CAPTURE_UNAVAILABLE: uniform image, no valid visual observation claimed'}
      $stream=New-Object IO.MemoryStream
      try {$bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png); $base64=[Convert]::ToBase64String($stream.ToArray())} finally {$stream.Dispose()}
      return @{window=(Window-Info $root);at=[DateTime]::UtcNow.ToString('o');mimeType='image/png';data=$base64;width=$width;height=$height;source='PrintWindow'}
    } finally {$g.Dispose();$bitmap.Dispose()}
  }
  throw 'OPERATION_NOT_SUPPORTED'
}
while($null -ne ($line=[Console]::ReadLine())) {
  try {
    $message=$line | ConvertFrom-Json
    $result=Invoke-Operation $message.op $message.params
    [Console]::WriteLine((@{id=$message.id;ok=$true;result=$result} | ConvertTo-Json -Depth 20 -Compress))
  } catch { [Console]::WriteLine((@{id=$message.id;ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Depth 5 -Compress)) }
}
