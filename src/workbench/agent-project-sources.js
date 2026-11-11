import {createReadStream} from 'node:fs';
import {readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {readJson} from './storage.js';

export async function databaseRows(file,read){
  if(!await stat(file).then(value=>value.isFile(),()=>false))return null;
  const {DatabaseSync}=await import('node:sqlite');
  const database=new DatabaseSync(file,{readOnly:true});
  try{return read(database);}finally{database.close();}
}

const optionalJson=file=>readJson(file,null).catch(()=>null);
const entries=directory=>readdir(directory,{withFileTypes:true}).catch(()=>[]);
const recentFiles=async(directory,pattern)=>{
  const files=(await entries(directory)).filter(item=>item.isFile()&&pattern.test(item.name))
    .map(item=>path.join(directory,item.name));
  const metadata=await Promise.all(files.map(async file=>({file,info:await stat(file).catch(()=>null)})));
  return metadata.filter(item=>item.info?.size<=8*1024*1024)
    .sort((a,b)=>b.info.mtimeMs-a.info.mtimeMs).slice(0,100);
};

async function readSessionLines(file,visit){
  const stream=createReadStream(file,{encoding:'utf8'});
  const lines=createInterface({input:stream,crlfDelay:Infinity});
  try{
    for await(const line of lines){
      try{if(line)visit(JSON.parse(line));}catch{/* An incomplete tail can appear while the Agent is writing. */}
    }
  }catch{/* Keep the metadata already read. */}
  finally{lines.close();stream.destroy();}
}

function firstText(content){
  const text=typeof content==='string'?content:Array.isArray(content)?content.find(block=>typeof block?.text==='string')?.text:null;
  return text?.trim().split(/\r?\n/,1)[0]?.slice(0,100)||'';
}

export async function piProjects(home){
  const root=process.env.PI_CODING_AGENT_SESSION_DIR||path.join(process.env.PI_CODING_AGENT_DIR||path.join(home,'.pi','agent'),'sessions');
  const directories=(await entries(root)).filter(item=>item.isDirectory()).slice(0,100);
  const files=(await Promise.all([recentFiles(root,/\.jsonl$/),...directories.map(item=>recentFiles(path.join(root,item.name),/\.jsonl$/))]))
    .flat().sort((a,b)=>b.info.mtimeMs-a.info.mtimeMs).slice(0,150);
  return Promise.all(files.map(async ({file,info})=>{
    let header,name,firstUser;
    await readSessionLines(file,row=>{
      if(row.type==='session')header=row;
      if(row.type==='session_info'&&typeof row.name==='string')name=row.name.trim();
      if(row.type==='message'&&row.message?.role==='user'&&!firstUser)firstUser=firstText(row.message.content);
    });
    return {id:header?.id,cwd:header?.cwd,title:name||firstUser,titleSource:name?'native':'preview',updatedAt:info.mtimeMs};
  }));
}

export async function geminiProjects(home){
  const root=path.join(process.env.GEMINI_CLI_HOME||home,'.gemini');
  const index=await optionalJson(path.join(root,'projects.json'));
  if(!index?.projects)return null;
  const result=[];
  for(const [cwd,slug] of Object.entries(index.projects)){
    if(typeof slug!=='string'||!slug||path.basename(slug)!==slug||slug==='.'||slug==='..')continue;
    const files=await recentFiles(path.join(root,'tmp',slug,'chats'),/^session-.*\.jsonl?$/);
    for(const {file,info} of files){
      let id,title,firstUser;
      const read=row=>{
        id??=row.sessionId;
        title=row.title||row.summary||row.$set?.title||row.$set?.summary||title;
        if(row.type==='user'&&!firstUser)firstUser=firstText(row.content);
      };
      if(file.endsWith('.jsonl'))await readSessionLines(file,read);
      else{
        const data=await optionalJson(file);
        if(data){read(data);for(const row of data.messages||[])read(row);}
      }
      if(id&&(title||firstUser))result.push({id,cwd,title:title||firstUser,titleSource:title?'native':'preview',updatedAt:info.mtimeMs});
    }
    result.push(cwd);
  }
  return result;
}

export async function dshProjects(home){
  const root=path.join(process.env.DSH_HOME||path.join(home,'.dsh'),'storages');
  const state=await optionalJson(path.join(root,'workspace.json'));
  const files=await recentFiles(path.join(root,'session_projcache','sessions'),/\.json$/);
  const pins=new Set(state?.global?.pinnedSessionIds||[]),archived=new Set(state?.global?.archivedSessionIds||[]);
  const tasks=await Promise.all(files.map(async ({file,info})=>{
    const id=path.basename(file,'.json'),record=(await optionalJson(file))?.record;
    if(!record?.identity||archived.has(id))return null;
    return {id,cwd:record.rows?.workingDirectory?.val||record.identity.cwd,title:record.rows?.title?.val,
      pinned:pins.has(id),updatedAt:record.rows?.sessionListMetadata?.val?.lastPromptAt||info.mtimeMs};
  }));
  const projects=Object.entries(state?.tables?.workspaces||{}).map(([id,workspace])=>({
    id,cwd:workspace.path,title:workspace.title,updatedAt:workspace.updatedAt,conversation:false,
  }));
  return [...projects,...tasks.filter(Boolean)];
}

export function hermesProjects(home){
  const root=process.env.HERMES_HOME||path.join(home,'.hermes');
  return databaseRows(path.join(root,'state.db'),database=>database.prepare(
    `SELECT id,cwd,title,pinned,COALESCE(last_activity_at,started_at) AS updatedAt FROM sessions
     WHERE COALESCE(archived,0)=0 AND COALESCE(hidden,0)=0 AND source IN ('cli','acp','desktop','web')
     ORDER BY updatedAt DESC LIMIT 250`).all().map(row=>({...row,unscoped:!row.cwd})));
}

export async function antigravityProjects(home){
  const roots=['antigravity-cli','antigravity'];
  const results=await Promise.all(roots.map(folder=>databaseRows(
    path.join(home,'.gemini',folder,'conversation_summaries.db'),
    database=>database.prepare(
      `SELECT conversation_id AS id,title,workspace_uris AS uris,last_modified_time AS updatedAt
       FROM conversation_summaries WHERE COALESCE(killed,0)=0 AND COALESCE(parent_conversation_id,'')=''
       ORDER BY updatedAt DESC LIMIT 200`).all()).catch(()=>null)));
  const seen=new Set(),projects=[];
  for(const row of results.flatMap(rows=>rows||[])){
    if(!row.title||seen.has(row.id))continue;
    let cwd;
    try{
      const uri=JSON.parse(row.uris).find(value=>typeof value==='string'&&value.startsWith('file:'));
      if(uri)cwd=fileURLToPath(uri);
    }catch{/* Some conversations were opened without a local folder. */}
    seen.add(row.id);projects.push({id:row.id,cwd,title:row.title,updatedAt:row.updatedAt,unscoped:!cwd});
  }
  return results.some(Boolean)?projects:null;
}

export function openCodeProjects(home){
  const directory=path.join(process.env.XDG_DATA_HOME||path.join(home,'.local','share'),'opencode');
  const override=process.env.OPENCODE_DB;
  if(override===':memory:')return null;
  return databaseRows(path.resolve(directory,override||'opencode.db'),database=>{
    const schema=database.prepare("SELECT name FROM sqlite_master WHERE name IN ('session_v2','session')").all();
    const table=schema.some(row=>row.name==='session_v2')?'session_v2':schema.some(row=>row.name==='session')?'session':null;
    const tasks=table?database.prepare(`SELECT id,directory AS cwd,title,time_updated AS updatedAt FROM ${table}
      WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 250`).all():[];
    const projects=database.prepare('SELECT id,worktree AS cwd,name AS title,time_updated AS updatedAt FROM project LIMIT 250').all();
    return [...tasks,...projects.map(row=>({...row,conversation:false}))];
  });
}
