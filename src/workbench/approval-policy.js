import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';

const privatePath=/(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.git|\.ssh|\.npmrc|\.netrc|auth\.json|credentials?(?:\.[^\\/]*)?|secrets?(?:\.[^\\/]*)?|tokens?(?:\.[^\\/]*)?)(?:$|[\\/])|\.(?:key|pem|p12|pfx)$/i;

export async function projectReadAllowed(workspace,target){
  if(typeof target!=='string'||!target||/[?*\u0000]/u.test(target)||target.startsWith('\\\\'))return false;
  const file=path.resolve(workspace,target);
  const relative=path.relative(workspace,file);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||relative.includes(':')||privatePath.test(relative))return false;
  try{
    const stat=await lstat(file);
    return stat.isFile()&&!stat.isSymbolicLink()&&path.relative(file,await realpath(file))==='';
  }catch{return false;}
}

export function acpReadTarget(tool){
  const input=tool?.rawInput;
  const name=tool?._meta?.['codebuddy.ai/toolName']??input?.tool;
  if(typeof name!=='string'||!['read','readfile','read_file'].includes(name.toLowerCase()))return;
  const args=input?.tool?input.input:input;
  return args?.file_path??args?.filePath??args?.path;
}
