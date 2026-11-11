import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const skillOps = new Set(['open_app','open_path','search_files','organize_folder','move_path','clipboard_read','clipboard_write','volume']);
const notice = '此应用窗口不属于知微的专用窗口，不能由 owned-window UIA 工具控制。';
const apps = { '记事本':'notepad.exe', notepad:'notepad.exe', '计算器':'calc.exe', calculator:'calc.exe', '画图':'mspaint.exe', paint:'mspaint.exe', '资源管理器':'explorer.exe', explorer:'explorer.exe', edge:'msedge.exe', '浏览器':'msedge.exe', '设置':'ms-settings:', settings:'ms-settings:', '任务管理器':'taskmgr.exe' };
const aliases = { '桌面':'Desktop', desktop:'Desktop', '下载':'Downloads', downloads:'Downloads', '文档':'Documents', documents:'Documents' };
const blocked = /\.(exe|bat|cmd|ps1|vbs|msi|lnk|reg|js)$/i;

export function runPowerShell(script, { input = {}, spawn: spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command','-'], { windowsHide:true });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('系统技能执行超时，结果可能未知')); }, 20000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(errors || `PowerShell exited ${code}`));
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, '').trim())); } catch { reject(new Error(errors || '系统技能没有返回 JSON')); }
    });
    // Keep stdin ASCII: Windows PowerShell 5.1 decodes commands using the local code page.
    // Both payloads stay on stdin, including clipboard text larger than the command-line limit.
    const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
    const encodedScript = Buffer.from(script, 'utf8').toString('base64');
    child.stdin.end(`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$ErrorActionPreference = 'Stop'\n$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json\n& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedScript}')))) | ConvertTo-Json -Depth 8 -Compress\n\n`, 'utf8');
  });
}

const audio = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Devices {
 int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
 [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out Device device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Device {
 [PreserveSig] int Activate(ref Guid iid, int context, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object result);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Endpoint {
 [PreserveSig] int RegisterControlChangeNotify(IntPtr notify); [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
 [PreserveSig] int GetChannelCount(out uint count); [PreserveSig] int SetMasterVolumeLevel(float level, Guid context);
 [PreserveSig] int SetMasterVolumeLevelScalar(float level, Guid context); [PreserveSig] int GetMasterVolumeLevel(out float level);
 [PreserveSig] int GetMasterVolumeLevelScalar(out float level); [PreserveSig] int SetChannelVolumeLevel(uint channel,float level,Guid context);
 [PreserveSig] int SetChannelVolumeLevelScalar(uint channel,float level,Guid context); [PreserveSig] int GetChannelVolumeLevel(uint channel,out float level);
 [PreserveSig] int GetChannelVolumeLevelScalar(uint channel,out float level); [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute,Guid context);
 [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
public class Audio {
 public static object Control(string action, int level) {
 Device device; Marshal.ThrowExceptionForHR(((Devices)new Enumerator()).GetDefaultAudioEndpoint(0,1,out device));
 Guid iid=typeof(Endpoint).GUID; object obj; Marshal.ThrowExceptionForHR(device.Activate(ref iid,23,IntPtr.Zero,out obj));
 Endpoint endpoint=(Endpoint)obj; float value; bool muted;
 Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out value));
 if(action=="set" || action=="up" || action=="down") {
 value=action=="set"?level/100f:Math.Max(0,Math.Min(1,value+(action=="up"?0.1f:-0.1f)));
 Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(value,Guid.Empty));
 }
 if(action=="mute" || action=="unmute") Marshal.ThrowExceptionForHR(endpoint.SetMute(action=="mute",Guid.Empty));
 Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out value));
 Marshal.ThrowExceptionForHR(endpoint.GetMute(out muted));
 return new { level=(int)Math.Round(value*100), muted=muted };
 }
}
'@
[Audio]::Control($p.action, [int]$p.level)`;

export class SystemSkills {
  constructor({ run = runPowerShell, fs: fileSystem = fs, homeDir = os.homedir(), workspace } = {}) {
    this.run = run; this.fs = fileSystem; this.homeDir = homeDir; this.workspace = workspace || process.cwd();
  }
  resolve(value) {
    const parts = value.split(/[\\/]/);
    const first = aliases[parts[0].toLowerCase()];
    if (parts[0] === '~' || first) return path.resolve(this.homeDir, ...(first ? [first, ...parts.slice(1)] : parts.slice(1)));
    return path.resolve(this.workspace, value);
  }
  async open_app({ name }) {
    const key = name.trim().toLowerCase();
    if (/(^|[^a-z])(cmd|powershell|pwsh|terminal|wt|regedit|bash|wsl|cscript|wscript)(\.exe)?($|[^a-z])|shell|command prompt|registry editor|终端|命令提示符|注册表|命令行/i.test(key)) throw new Error('不允许启动终端、shell 或注册表编辑器');
    const target = apps[key];
    const result = await this.run(target ? `Start-Process -FilePath $p.target\n@{launched=$p.target}` : `
$roots = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
$match = Get-ChildItem -LiteralPath $roots -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.BaseName.IndexOf($p.name, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.BaseName -notmatch 'cmd|powershell|pwsh|terminal|regedit|bash|wsl|shell|command prompt|registry editor|终端|命令|注册表' } | Sort-Object @{Expression={if($_.BaseName -ieq $p.name){0}else{1}}}, @{Expression={$_.BaseName.Length}}, FullName | Select-Object -First 1
if (!$match) { throw '未找到开始菜单应用' }
Start-Process -FilePath $match.FullName
@{launched=$match.FullName}`, { input:target ? { target } : { name:key } });
    return { ...result, note:notice };
  }
  async open_path({ path: value }) {
    const target = this.resolve(value), stat = await this.fs.stat(target);
    if (!stat.isDirectory() && blocked.test(target)) throw new Error('不能通过 open_path 运行程序或脚本');
    return { ...await this.run(stat.isDirectory() ? 'Start-Process -FilePath explorer.exe -ArgumentList @(\'"\' + $p.path + \'"\')\n@{opened=$p.path}' : 'Start-Process -FilePath $p.path\n@{opened=$p.path}', { input:{ path:target } }), note:notice };
  }
  async search_files({ query, folder, limit = 20 }) {
    limit = Math.max(1, Math.min(100, limit));
    const roots = folder ? [this.resolve(folder)] : ['Desktop','Documents','Downloads'].map(p => path.join(this.homeDir,p)).concat(this.workspace);
    const pattern = new RegExp(query.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');
    const results = [], seen = new Set(); let visited = 0;
    const walk = async (dir, depth) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      let entries;
      try { entries = await this.fs.readdir(dir, { withFileTypes:true }); } catch (error) { if (['ENOENT','EACCES','EPERM'].includes(error.code)) return; throw error; }
      for (const entry of entries) {
        if (visited >= 5000 || results.length >= limit) return;
        visited++;
        if (entry.name.startsWith('.') || /^(node_modules|AppData|System Volume Information|\$RECYCLE.BIN|Windows|ProgramData)$/i.test(entry.name) || entry.isSymbolicLink()) continue;
        const target = path.join(dir,entry.name);
        if (pattern.test(entry.name)) {
          const stat = await this.fs.stat(target);
          results.push({ path:target, size:stat.size, modified:stat.mtime.toISOString(), isDir:entry.isDirectory() });
        }
        if (entry.isDirectory() && depth < 6) await walk(target, depth+1);
      }
    };
    for (const root of new Set(roots)) await walk(root, 0);
    return { results, visited };
  }
  async absent(target) {
    try { await this.fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('目标已存在，禁止覆盖');
  }
  async move_path({ from, to }) {
    from = this.resolve(from); to = this.resolve(to);
    await this.absent(to); await this.fs.rename(from,to);
    return { from, to };
  }
  async organize_folder({ folder, by, apply = false }) {
    const root = this.resolve(folder), entries = await this.fs.readdir(root, { withFileTypes:true });
    const categories = { '图片':'jpg jpeg png gif webp bmp svg heic ico tif tiff', '文档':'txt pdf doc docx rtf md odt', '表格':'xls xlsx csv ods', '演示':'ppt pptx odp', '压缩包':'zip rar 7z tar gz', '音频':'mp3 wav flac aac m4a ogg', '视频':'mp4 mkv avi mov wmv webm', '安装包':'exe msi msix' };
    const plan = [], reserved = new Set();
    for (const entry of entries.filter(e => e.isFile()).slice(0,500)) {
      const from = path.join(root,entry.name), ext = path.extname(entry.name).slice(1).toLowerCase();
      const category = by === 'date' ? (await this.fs.stat(from)).mtime.toISOString().slice(0,7) : Object.keys(categories).find(k => categories[k].split(' ').includes(ext)) || '其他';
      const dir = path.join(root,category); let to = path.join(dir,entry.name), n = 2;
      while (true) {
        try { if (reserved.has(to)) throw new Error('reserved'); await this.absent(to); break; }
        catch (error) { if (error.message !== 'reserved' && error.message !== '目标已存在，禁止覆盖') throw error; }
        to = path.join(dir,`${path.basename(entry.name,path.extname(entry.name))} (${n++})${path.extname(entry.name)}`);
      }
      reserved.add(to); plan.push({ from,to });
    }
    const moved = [];
    if (apply) for (const move of plan) { await this.fs.mkdir(path.dirname(move.to), { recursive:true }); moved.push(await this.move_path(move)); }
    return { apply, plan, moved };
  }
  clipboard_read() { return this.run('@{text=(Get-Clipboard -Raw)}'); }
  clipboard_write({ text }) { return this.run('Set-Clipboard -Value $p.text\n@{written=$p.text.Length}', { input:{ text } }); }
  volume({ action, level }) {
    if (action === 'set' && (!Number.isInteger(level) || level < 0 || level > 100)) throw new Error('设置音量需要 0-100 的 level');
    return this.run(audio, { input:{ action, level:level ?? 0 } });
  }
}
