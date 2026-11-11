import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,copyFile,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const out=path.resolve(process.argv[2]||path.join(root,'work','release'));
await mkdir(out,{recursive:true});
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const {stdout}=await exec('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024,windowsHide:true});
const rootFiles=new Set(['README.md','LICENSE','CONTRIBUTING.md','SECURITY.md','package.json','package-lock.json','.gitignore','.gitattributes','start.bat','open-zhiwei.vbs','一键验收.bat']);
const selected=[...new Set(stdout.split('\0').filter(Boolean))].filter(file=>rootFiles.has(file)||/^(src|public|test|scripts|docs|\.github)\//.test(file)).sort();
const forbidden=/(^|\/)(data|node_modules|recordings|voiceprints|\.git)(\/|$)|\.(wav|pcm|mp3|m4a|flac|ogg|opus|webm|onnx|bin|dll|pdb|sqlite|db|key|pem|p12|pfx|token)(-|\.|$)|(^|\/)(\.env(?:\..*)?|auth\.json|credentials\.json|secrets\.json|tokens\.json)$/i;
const privateKey=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{25,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9]{28,}/;
if(!selected.length)throw Error('没有可打包的源码。');
const stage=await mkdtemp(path.join(out,'stage-')),release=path.join(stage,'沈知微-'+pkg.version),manifest=[];
await mkdir(release);
for(const file of selected){
  if(file.includes('..')||path.isAbsolute(file)||forbidden.test(file))throw Error('发行文件包含禁止项：'+file);
  const source=path.join(root,file),info=await lstat(source);
  if(!info.isFile()||info.isSymbolicLink())throw Error('发行文件不是普通文件：'+file);
  const bytes=await readFile(source);
  if(!/\.(png|jpe?g|webp|ico)$/i.test(file)&&privateKey.test(bytes.toString('utf8')))throw Error('发现疑似真实密钥，未打包：'+file);
  await mkdir(path.dirname(path.join(release,file)),{recursive:true});await copyFile(source,path.join(release,file));
  manifest.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await writeFile(path.join(release,'源码清单.json'),JSON.stringify({product:'沈知微',version:pkg.version,generatedAt:new Date().toISOString(),files:manifest},null,2)+'\n','utf8');
const zip=path.join(out,'沈知微-'+pkg.version+'-源码.zip');
if(process.platform!=='win32')throw Error('源码已导出，但当前源码压缩步骤需要 Windows。');
const literal=value=>"'"+value.replaceAll("'","''")+"'";
await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; if(Test-Path -LiteralPath '+literal(zip)+'){Remove-Item -LiteralPath '+literal(zip)+'}; [IO.Compression.ZipFile]::CreateFromDirectory('+literal(stage)+','+literal(zip)+',[IO.Compression.CompressionLevel]::Optimal,$false)'],{windowsHide:true,timeout:120000,maxBuffer:32000});
const bytes=await readFile(zip),summary={product:'沈知微',version:pkg.version,source:release,zip,files:manifest.length,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sensitiveFiles:0,historyIncluded:false};
await writeFile(path.join(out,'发行包核验.json'),JSON.stringify(summary,null,2)+'\n','utf8');
console.log(JSON.stringify(summary));
