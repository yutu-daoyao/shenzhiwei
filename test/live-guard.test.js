import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('automatic test discovery cannot run live Agent, voice or desktop acceptance scripts',async()=>{
  const files=['live-test','features-live-test','voice-live-test','browser-live-test','computer-live-test'].map(name=>'scripts/'+name+'.js');
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const {stdout}=await exec(process.execPath,['--test','--test-concurrency=2',...files],{env,windowsHide:true,timeout:20000,maxBuffer:128000});
  assert.equal((stdout.match(/跳过自动发现的真实服务实测/g)||[]).length,files.length);
  assert.ok(!stdout.includes('DASHSCOPE_API_KEY'));
});
