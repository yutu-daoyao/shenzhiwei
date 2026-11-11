param([Parameter(Mandatory)][long]$WindowId,[switch]$IncludeImage)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZhiweiScreenNative {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[ZhiweiScreenNative]::SetProcessDPIAware() | Out-Null
$h=[IntPtr]$WindowId
$desktop=[ZhiweiScreenNative]::OpenInputDesktop(0,$false,1)
if($desktop -eq [IntPtr]::Zero){throw 'No interactive desktop'}
[ZhiweiScreenNative]::CloseDesktop($desktop) | Out-Null
if([ZhiweiScreenNative]::GetForegroundWindow() -ne $h -or [ZhiweiScreenNative]::IsIconic($h)){throw 'Foreground changed'}
$element=[System.Windows.Automation.AutomationElement]::FromHandle($h)
$focused=[System.Windows.Automation.AutomationElement]::FocusedElement
if($focused.Current.IsPassword){throw 'Password field'}
$password=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsPasswordProperty,$true)
if($null -ne $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$password)){throw 'Sensitive window'}
$title=$element.Current.Name
$bounds=$element.Current.BoundingRectangle
$text=''
$pattern=$null
$documentCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document)
$document=$element.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$documentCondition)
$reader=if($null -ne $document){$document}else{$element}
if($reader.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)){
    $ranges=$pattern.GetVisibleRanges()
    foreach($range in $ranges){$text+=$range.GetText([Math]::Max(0,8000-$text.Length));if($text.Length -ge 8000){break}}
}else {
    $nodes=$element.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $parts=New-Object 'System.Collections.Generic.List[string]'
    for($i=0;$i -lt [Math]::Min(120,$nodes.Count);$i++){
        $node=$nodes.Item($i)
        if(!$node.Current.IsOffscreen -and !$node.Current.IsPassword -and $node.Current.Name){$parts.Add($node.Current.Name)}
    }
    $text=($parts -join "`n")
}
$result=@{title=[string]$title;text=[string]$text.Substring(0,[Math]::Min($text.Length,8000))}
if($IncludeImage){
    if($bounds.Width -lt 10 -or $bounds.Height -lt 10 -or $bounds.Width -gt 10000 -or $bounds.Height -gt 10000){throw 'Invalid bounds'}
    $source=New-Object Drawing.Bitmap([int]$bounds.Width,[int]$bounds.Height)
    $g=[Drawing.Graphics]::FromImage($source)
    try{$g.CopyFromScreen([int]$bounds.Left,[int]$bounds.Top,0,0,$source.Size)}finally{$g.Dispose()}
    try{
        if([ZhiweiScreenNative]::GetForegroundWindow() -ne $h){throw 'Foreground changed'}
        $scale=[Math]::Min(1,[Math]::Min(1600/$bounds.Width,1000/$bounds.Height))
        $image=New-Object Drawing.Bitmap([int]($bounds.Width*$scale),[int]($bounds.Height*$scale))
        $paint=[Drawing.Graphics]::FromImage($image)
        try{$paint.DrawImage($source,0,0,$image.Width,$image.Height)}finally{$paint.Dispose()}
        $stream=New-Object IO.MemoryStream
        try{
            $image.Save($stream,[Drawing.Imaging.ImageFormat]::Jpeg)
            if($stream.Length -gt 2500000){throw 'Image too large'}
            $result.image='data:image/jpeg;base64,'+[Convert]::ToBase64String($stream.ToArray())
        }finally{$stream.Dispose();$image.Dispose()}
    }finally{$source.Dispose()}
}
$result | ConvertTo-Json -Compress -Depth 3
}catch{[Console]::WriteLine('{"error":"screen unavailable"}')}
