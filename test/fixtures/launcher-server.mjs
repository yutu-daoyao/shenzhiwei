import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({workspace:path.join(process.cwd(),'test-workspace'),voice:{enabled:false},task:{status:'idle'}}));
});
await new Promise(resolve=>setTimeout(resolve,600));
server.listen(Number(process.env.PORT),'127.0.0.1',async()=>{
  if(process.env.ZHIWEI_LAUNCH_TEST_PID_FILE)await writeFile(process.env.ZHIWEI_LAUNCH_TEST_PID_FILE,String(process.pid));
});
