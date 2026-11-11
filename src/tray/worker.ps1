$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Console.In.ReadLineAsync can block synchronously on .NET Framework. Read on a CLR thread.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading;
public static class ZhiweiTrayInput {
    public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    public static volatile bool Ended;
    public static void Start() {
        var reader = new Thread(() => {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) Lines.Enqueue(line);
            } finally { Ended = true; }
        });
        reader.IsBackground = true;
        reader.Start();
    }
}
'@
Add-Type -Path (Join-Path $PSScriptRoot 'desktop.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing
$ring=New-Object ZhiweiDesktopRing((Join-Path $PSScriptRoot '../../public/scene-mobius.png'))
[ZhiweiTrayInput]::Start()
$script:configured = $false
$context = New-Object System.Windows.Forms.ApplicationContext
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = 'Zhiwei'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Emit-Action([string]$action) {
    [Console]::WriteLine((@{type='action';action=$action} | ConvertTo-Json -Compress))
}
$open = $menu.Items.Add(([char]25171 + [char]24320 + [char]30693 + [char]24494))
$start = $menu.Items.Add(([char]24320 + [char]22987 + [char]21518 + [char]21488 + [char]35821 + [char]38899))
$stop = $menu.Items.Add(([char]20572 + [char]27490 + [char]35821 + [char]38899))
$exit = $menu.Items.Add(([char]36864 + [char]20986 + [char]30693 + [char]24494))
# Opening is handled here from the validated origin, without a shell command string.
$open.Add_Click({ if ($script:configured) { Start-Process -FilePath $script:origin } })
$icon.Add_DoubleClick({ if ($script:configured) { Start-Process -FilePath $script:origin } })
$start.Add_Click({ Emit-Action 'start' })
$stop.Add_Click({ Emit-Action 'stop' })
$exit.Add_Click({ Emit-Action 'exit' })
$icon.ContextMenuStrip = $menu
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 33
$timer.Add_Tick({
    try {
        $eventLine=$null
        while($ring.Actions.TryDequeue([ref]$eventLine)){[Console]::WriteLine($eventLine)}
        $line = $null
        $processed=0
        while ([ZhiweiTrayInput]::Lines.TryDequeue([ref]$line)) {
        $message = $line | ConvertFrom-Json
        switch ($message.type) {
            'configure' {
                if ($script:configured) { throw 'Already configured' }
                $uri = [Uri]$message.origin
                if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1') { throw 'Invalid origin' }
                $script:origin = $message.origin
                $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
                if ($message.autostart) {
                    New-Item -Path $key -Force | Out-Null
                    New-ItemProperty -Path $key -Name 'ZhiweiDesktop' -PropertyType String -Value $message.command -Force | Out-Null
                } else {
                    Remove-ItemProperty -Path $key -Name 'ZhiweiDesktop' -ErrorAction SilentlyContinue
                }
                $start.Enabled = !$message.listening
                $stop.Enabled = [bool]$message.listening
                $script:configured = $true
                $icon.Visible = $true
                [Console]::WriteLine('{"type":"ready"}')
                $registered=$ring.Configure([bool]$message.desktopEnabled)
                [Console]::WriteLine((@{type='desktop-ready';ready=($registered -and [bool]$message.desktopEnabled);error=$(if(!$registered){'Ctrl+Space is already in use'}else{$null})}|ConvertTo-Json -Compress))
            }
            'listening' {
                $start.Enabled = !$message.value
                $stop.Enabled = [bool]$message.value
            }
            'desktop-enabled' {
                $registered=$ring.Configure([bool]$message.value)
                [Console]::WriteLine((@{type='desktop-ready';ready=($registered -and [bool]$message.value);error=$(if(!$registered){'Ctrl+Space is already in use'}else{$null})}|ConvertTo-Json -Compress))
            }
            'overlay' {$ring.UpdateState([string]$message.state,[string]$message.text,[double]$message.level)}
            'quit' { $context.ExitThread(); return }
            default { throw 'Invalid command' }
        }
        $processed++
        if($processed -ge 64){break}
        }
        if([ZhiweiTrayInput]::Ended -and [ZhiweiTrayInput]::Lines.IsEmpty){$context.ExitThread()}
    } catch {
        [Console]::Error.WriteLine('Tray worker failed')
        $context.ExitThread()
    }
})
try {
    $timer.Start()
    [System.Windows.Forms.Application]::Run($context)
} finally {
    $timer.Stop(); $timer.Dispose()
    $ring.Dispose()
    $icon.Visible = $false
    $icon.Dispose(); $menu.Dispose(); $context.Dispose()
}
