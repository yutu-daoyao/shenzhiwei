import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function readJson(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw new Error('工作台记录无法读取，原文件未覆盖。');}}
export async function writeJson(file,value){
  await mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
}
