import {readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

const packages={
  'gemini-cli':{bin:'gemini',packages:['@google/gemini-cli'],override:'ZHIWEI_GEMINI_CLI'},
  pi:{bin:'pi',packages:['@earendil-works/pi-coding-agent','@mariozechner/pi-coding-agent'],override:'ZHIWEI_PI_CLI'},
};
export async function findLocalCli(agent){
  const entry=packages[agent];
  const dirs=String(process.env.PATH||'').split(path.delimiter).map(dir=>dir.replace(/^"|"$/g,'')).filter(dir=>path.isAbsolute(dir));
  if(process.platform==='win32'){
    const local=process.env.LOCALAPPDATA||path.join(homedir(),'AppData','Local');
    if(process.env.APPDATA)dirs.push(path.join(process.env.APPDATA,'npm'));
    if(agent==='pi')dirs.push(path.join(local,'hermes','node'));
  }
  const modules=new Set(dirs.flatMap(dir=>[path.join(dir,'node_modules'),path.resolve(dir,'../lib/node_modules')]));
  const candidates=[];
  const override=process.env[entry.override];
  if(override&&path.isAbsolute(override))candidates.push(override);
  for(const directory of modules)for(const name of entry.packages){
    const root=path.join(directory,name);
    try{
      const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
      const bin=typeof manifest.bin==='string'?manifest.bin:manifest.bin?.[entry.bin];
      if(typeof bin!=='string')continue;
      const file=path.resolve(root,bin),relative=path.relative(root,file);
      if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))candidates.push(file);
    }catch{}
  }
  for(const file of candidates)if(/\.[cm]?js$/i.test(file)&&await stat(file).then(s=>s.isFile(),()=>false))return file;
  throw Error(`未找到 ${entry.bin} 的 Node CLI，请检查安装或设置 ${entry.override} 为 CLI 文件路径。`);
}
