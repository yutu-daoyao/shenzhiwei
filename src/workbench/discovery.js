import {stat,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {findCodex} from '../codex/process.js';
import {acpCommand} from './acp-process.js';
import {findLocalCli} from './local-cli.js';
import {findOpenCode} from './opencode-process.js';

const windows=process.platform==='win32';
const additional=[
  {id:'claude-code',name:'Claude Code',commands:['claude']},
  {id:'cursor-agent',name:'Cursor Agent',commands:['cursor-agent']},
  {id:'copilot-cli',name:'GitHub Copilot CLI',commands:['copilot']},
  {id:'aider',name:'Aider',commands:['aider']},
  {id:'goose',name:'Goose',commands:['goose']},
  {id:'amp',name:'Amp',commands:['amp']},
];

export function grokBotPath(){
  return process.env.ZHIWEI_GROK_BOT_EXE||path.join(process.env.LOCALAPPDATA||'','Programs/Grok Bot/Grok Bot.exe');
}

async function isFile(file,executable=false){
  try{
    if(!(await stat(file)).isFile())return false;
    if(executable&&!windows)await access(file,constants.X_OK);
    return true;
  }catch{return false;}
}

async function onPath(command){
  if(path.isAbsolute(command))return isFile(command,true);
  if(/[\\/]/.test(command))return false;
  const dirs=[...String(process.env.PATH||'').split(path.delimiter),path.join(homedir(),'.local','bin')];
  if(windows&&process.env.APPDATA)dirs.push(path.join(process.env.APPDATA,'npm'));
  const extensions=windows&&!path.extname(command)?['.exe','.cmd','.bat']:[''];
  const candidates=dirs.map(dir=>dir.replace(/^"|"$/g,'')).filter(dir=>path.isAbsolute(dir))
    .flatMap(dir=>extensions.map(ext=>path.join(dir,command+ext)));
  return (await Promise.all(candidates.map(file=>isFile(file,true)))).some(Boolean);
}

export async function detectLocalAgents(){
  const probes={
    codex:()=>findCodex({verify:false}).then(()=>true),
    'gemini-cli':()=>findLocalCli('gemini-cli').then(()=>true),
    pi:()=>findLocalCli('pi').then(()=>true),
    opencode:()=>findOpenCode({verify:false}).then(()=>true),
    dsh:()=>acpCommand('dsh').then(spec=>isFile(spec.args[0])),
    workbuddy:()=>acpCommand('workbuddy').then(spec=>isFile(spec.args[0])),
    hermes:()=>acpCommand('hermes').then(spec=>onPath(spec.command)),
    antigravity:()=>acpCommand('antigravity').then(spec=>onPath(spec.command)),
    'grok-bot':()=>windows&&isFile(grokBotPath()),
  };
  const [supported,other]=await Promise.all([
    Promise.all(Object.entries(probes).map(async ([id,probe])=>[id,await Promise.resolve().then(probe).catch(()=>false)])),
    Promise.all(additional.map(async ({id,name,commands})=>(await Promise.all(commands.map(onPath))).some(Boolean)?{id,name,detected:true,implemented:false,status:'discovered'}:null)),
  ]);
  return {supported:Object.fromEntries(supported),other:other.filter(Boolean)};
}
