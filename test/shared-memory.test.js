import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openMemory} from '../src/memory/store.js';
import {sharedMemoryFile,sharedContext} from '../src/memory/shared.js';
test('shared folder migrates committed WAL records consistently, preserves the old DB and never overwrites new records',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'zhiwei-shared-')),legacy=await openMemory(dir);let shared,again;
  t.after(async()=>{again?.close();shared?.close();legacy.close();await rm(dir,{recursive:true,force:true});});
  legacy.setPreference('语言','中文');legacy.remember('喜欢简短的操作说明');legacy.recordTask({threadId:'old',turnId:'old',request:'项目甲私有任务',outcome:'私有内容',status:'completed'});
  const file=await sharedMemoryFile(dir);assert.equal(path.dirname(file),path.join(dir,'memory'));shared=await openMemory(dir,{file});assert.equal(shared.recentTasks().length,1);assert.equal(shared.getPreferences()[0].value,'中文');
  const context=sharedContext(shared);assert.match(context,/中文|简短/);assert.doesNotMatch(context,/项目甲|私有/);
  shared.remember('新增共同记忆');assert.equal(await sharedMemoryFile(dir),file);again=await openMemory(dir,{file});assert.equal(again.search('新增共同记忆').length,1);assert.equal(legacy.search('新增共同记忆').length,0);
  shared.deletePreference('语言');shared.forget(shared.search('简短')[0].id);
  assert.doesNotMatch(sharedContext(shared),/中文|简短|项目甲|私有/);
});
