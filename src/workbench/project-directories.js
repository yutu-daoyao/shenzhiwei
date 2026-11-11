import {homedir} from 'node:os';
import path from 'node:path';
import {readJson} from './storage.js';
import {antigravityProjects,dshProjects,geminiProjects,hermesProjects,openCodeProjects,piProjects} from './agent-project-sources.js';

async function workBuddyProjects(home) {
  const directory=path.join(home,'.workbuddy');
  const index=await readJson(path.join(directory,'app','sessions.json'),null);
  const recent=Array.isArray(index?.sessions)?index.sessions:[];
  const fallback=recent.map(session=>session?.workDir);
  const accounts=[...new Set(recent.map(session=>session?.userId).filter(id=>typeof id==='string'&&id))];
  if(!accounts.length)return index?fallback:null;
  let database;
  try{
    const {DatabaseSync}=await import('node:sqlite');
    database=new DatabaseSync(path.join(directory,'workbuddy.db'),{readOnly:true});
    const placeholders=accounts.map(()=>'?').join(',');
    const rows=database.prepare(`SELECT id, cwd, title, custom_title, updated_at FROM sessions
      WHERE deleted_at IS NULL AND COALESCE(is_background_automation,0)=0
      AND user_id IN (${placeholders})
      ORDER BY updated_at DESC LIMIT 300`).all(...accounts);
    return [...rows.map(row=>({id:row.id,cwd:row.cwd,title:row.custom_title?.trim()||row.title,updatedAt:row.updated_at})),...fallback];
  }catch{
    return fallback;
  }finally{database?.close();}
}

const sources={workbuddy:workBuddyProjects,'gemini-cli':geminiProjects,opencode:openCodeProjects,
  dsh:dshProjects,hermes:hermesProjects,antigravity:antigravityProjects,pi:piProjects};
export async function desktopProjectDirectories(agent,home=homedir()){
  return Object.hasOwn(sources,agent)?sources[agent](home):null;
}
