param(
    [ValidateRange(1, 65535)][int]$Port = 4317,
    [string]$NodePath = '',
    [string]$EntryPath = (Join-Path $PSScriptRoot '..\src\main.js'),
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$root = Split-Path $PSScriptRoot
$origin = "http://127.0.0.1:$Port"
$workspace = [IO.Path]::GetFullPath((Join-Path $root 'test-workspace'))
$mutex = New-Object Threading.Mutex($false, "Local\ZhiweiLauncher-$Port")
$locked = $false

function Test-Zhiwei {
    $response = $null
    try {
        $request = [Net.WebRequest]::Create("$origin/api/state")
        $request.Proxy = $null
        $request.Timeout = 1000
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { $state = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        # The active project can change; the original workbench workspace identifies this installation.
        $ownWorkspace = $state.workspace -eq $workspace -or @($state.workbench.projects | Where-Object { $_.id -eq 'default' -and $_.cwd -eq $workspace }).Count -gt 0
        if (!$ownWorkspace -or !$state.PSObject.Properties['voice'] -or !$state.PSObject.Properties['task']) {
            throw "端口 $Port 已被其他服务占用，未启动第二个知微。"
        }
        return $true
    } catch [Net.WebException] {
        if ($_.Exception.Response) { throw "端口 $Port 已被其他服务占用。" }
        return $false
    } finally { if ($response) { $response.Dispose() } }
}

try {
    try { $locked = $mutex.WaitOne(45000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw '知微仍在启动，请稍候再打开。' }
    if (!(Test-Zhiwei)) {
        if (!$NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
        if (!(Test-Path -LiteralPath $EntryPath -PathType Leaf)) { throw '找不到知微程序，请保留原项目文件夹。' }
        $logs = Join-Path $root 'data'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        if (!(Test-Path -LiteralPath (Join-Path $root 'node_modules\ws\package.json'))) {
            Push-Location $root
            try {
                & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund *> (Join-Path $logs 'launcher-install.log')
                if ($LASTEXITCODE -ne 0) { throw '首次依赖安装失败，请检查网络。详情见 data\launcher-install.log。' }
            } finally { Pop-Location }
        }
        # Explorer may have an older environment than the already configured user account.
        if (!$env:DASHSCOPE_API_KEY) { $env:DASHSCOPE_API_KEY = [Environment]::GetEnvironmentVariable('DASHSCOPE_API_KEY', 'User') }
        $pidFile = Join-Path $logs "launcher-$Port.json"
        $child = $null
        try {
            $saved = Get-Content -LiteralPath $pidFile -Raw -ErrorAction Stop | ConvertFrom-Json
            $candidate = Get-Process -Id $saved.pid -ErrorAction Stop
            if (!$candidate.HasExited -and [string]$candidate.StartTime.Ticks -eq $saved.ticks -and $saved.entry -eq [IO.Path]::GetFullPath($EntryPath)) { $child = $candidate }
        } catch { }
        if (!$child) {
            $priorPort = $env:PORT
            try {
                $env:PORT = [string]$Port
                $child = Start-Process -FilePath $NodePath -ArgumentList ('"' + $EntryPath + '"') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs "launcher-$Port.log") -RedirectStandardError (Join-Path $logs "launcher-$Port-error.log")
                @{pid=$child.Id; ticks=[string]$child.StartTime.Ticks; entry=[IO.Path]::GetFullPath($EntryPath)} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
            } finally { $env:PORT = $priorPort }
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(35)
        while (!(Test-Zhiwei)) {
            $child.Refresh()
            if ($child.HasExited) { throw "知微启动失败，请查看 data\launcher-$Port-error.log。" }
            if ([DateTime]::UtcNow -gt $deadline) { throw '知微启动较慢，请稍后再双击；不会重复启动后台。' }
            Start-Sleep -Milliseconds 200
        }
    }
    if (!$NoOpen) {
        $chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
        $edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $chrome) {
            # Dedicated profile retains the browser's official on-device translation language pack.
            $profile = Join-Path $root 'data\browser-profile'
            Start-Process -FilePath $chrome -ArgumentList @(('--user-data-dir="' + $profile + '"'), "--app=$origin", '--no-first-run') -WindowStyle Normal
        } elseif (Test-Path -LiteralPath $edge) {
            Start-Process -FilePath $edge -ArgumentList "--app=$origin" -WindowStyle Normal
        } else { Start-Process -FilePath $origin }

    }
    Write-Output "Zhiwei ready: $origin"
} catch {
    if ($NoOpen) { throw }
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, '知微启动失败', 'OK', 'Error') | Out-Null
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
