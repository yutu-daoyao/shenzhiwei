import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createDecipheriv,createHash} from 'node:crypto';

export const SESSION_CONSENT='需要你明确允许：仅在本机读取并解密网易叭哥说专用 WebView 的网易登录会话，登录信息只发往网易有道接口，不写入项目或日志。';
const authenticationNames=new Set(['DICT_UT','DICT-PC','cf7','umurscookie','DICT_LOGIN','DICT_SESS','NTES_YD_SESS','P_INFO','S_INFO']);
let cachedSession;
export function clearInstalledSession(){cachedSession=null;}
export function installedSessionReady(){return !!cachedSession&&cachedSession.until>Date.now();}
export function accountFingerprint(login,deviceId){
  // Refresh tokens and loggedInAt can change when the same client reopens.
  // Logout is checked separately; a revoked cookie is cleared on HTTP 401.
  return createHash('sha256').update(JSON.stringify([login.userId,deviceId])).digest('hex');
}

function unprotect(blob){
  return new Promise((resolve,reject)=>{
    const script='Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $k=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($k))';
    const child=execFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:4096},(error,stdout)=>error?reject(new Error('当前 Windows 用户无法读取叭哥说会话。')):resolve(Buffer.from(stdout.trim(),'base64')));
    child.stdin.on('error',()=>{});child.stdin.end(blob.toString('base64'));
  });
}

// No filesystem or credential access happens before explicit consent.
// Reads only this installed app; never scans Chrome/Edge profiles or dictation history.
export async function loadInstalledAuth({authorized=false,read=readFile}={}){
  if(authorized!==true){clearInstalledSession();throw new Error(SESSION_CONSENT);}
  if(process.platform!=='win32')throw new Error('当前叭哥说适配仅支持 Windows 已安装客户端。');
  let key,temp,db,stage='读取客户端账号';
  try{
    const {login,deviceId}=JSON.parse(await read(path.join(process.env.APPDATA,'com.bageshuo/bageshuo-store.json'),'utf8'));
    if(!login?.loggedIn||typeof login.userId!=='string'||!login.userId||typeof deviceId!=='string'||!deviceId){clearInstalledSession();throw new Error('请先在网易叭哥说客户端登录。');}
    const fingerprint=accountFingerprint(login,deviceId);
    if(installedSessionReady()&&cachedSession.fingerprint===fingerprint)return {...cachedSession.auth};
    clearInstalledSession();
    const base=path.join(process.env.LOCALAPPDATA,'com.bageshuo/EBWebView');
    stage='读取客户端加密配置';const info=JSON.parse(await read(path.join(base,'Local State'),'utf8')).os_crypt;
    const encryptedKey=Buffer.from(info?.encrypted_key||'','base64');
    if(encryptedKey.subarray(0,5).toString()!=='DPAPI')throw new Error('本机叭哥说登录存储格式尚不支持，未尝试绕过系统保护。');
    stage='解密客户端密钥';key=await unprotect(encryptedKey.subarray(5));
    const {DatabaseSync}=await import('node:sqlite');
    // Windows may lock the live SQLite file. The encrypted snapshot lives only in
    // the current user's temporary folder and is removed before this function returns.
    temp=await mkdtemp(path.join(tmpdir(),'zhiwei-bage-auth-'));
    stage='读取客户端会话数据库';const copy=path.join(temp,'Cookies');await writeFile(copy,await read(path.join(base,'Default/Network/Cookies')),{mode:0o600});
    stage='解析客户端会话数据库';
    db=new DatabaseSync(copy,{readOnly:true});
    const version=Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value||0);
    const query=db.prepare("SELECT host_key,name,value,encrypted_value,expires_utc FROM cookies WHERE host_key='youdao.com' OR host_key LIKE '%.youdao.com'");
    query.setReadBigInts(true);const rows=query.all();
    const cookies={};let until=Date.now()+6*60*60*1000;
    for(const row of rows){
      if(!authenticationNames.has(row.name)||row.expires_utc&&Number(row.expires_utc)/1000-11644473600000<Date.now())continue;
      if(row.expires_utc)until=Math.min(until,Number(row.expires_utc)/1000-11644473600000);
      if(row.value){cookies[row.name]=row.value;continue;}
      const encrypted=Buffer.from(row.encrypted_value),format=encrypted.subarray(0,3).toString();
      if(!['v10','v11'].includes(format))continue;
      stage='解密网易登录会话';const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(3,15));decipher.setAuthTag(encrypted.subarray(-16));
      const plain=Buffer.concat([decipher.update(encrypted.subarray(15,-16)),decipher.final()]);
      cookies[row.name]=plain.subarray(version>=24?32:0).toString('utf8');plain.fill(0);
    }
    const entries=Object.entries(cookies).filter(([,value])=>value&&!/[\r\n;]/.test(value));
    if(!entries.length)throw new Error('叭哥说登录会话不可用，请在客户端重新登录后再试。');
    const auth={cookie:entries.map(([name,value])=>name+'='+value).join('; '),userId:login.userId,deviceId};
    // ponytail: one account session in process memory for at most six hours;
    // recheck the installed account on every use, clear on logout/revoke/401/exit.
    cachedSession={auth,fingerprint,until};return {...auth};
  }catch(error){
    if(error.message===SESSION_CONSENT||/^请先|^本机叭哥说|^叭哥说登录|^当前 Windows/.test(error.message))throw error;
    const code=typeof error.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'UNAVAILABLE';
    if(code==='EBUSY')throw new Error('无法读取叭哥说登录会话：文件被占用。请从系统托盘退出叭哥说，再恢复知微语音输入。');
    throw new Error(`无法读取叭哥说登录会话（${stage}：${code}），客户端原登录未修改。`);
  }finally{
    key?.fill(0);db?.close();
    if(temp&&path.dirname(path.resolve(temp))===path.resolve(tmpdir()))await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
