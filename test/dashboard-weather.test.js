import test from 'node:test';import assert from 'node:assert/strict';
import {WeatherForecast,LAISHAN} from '../src/server/weather.js';
import {groupProjects,weatherLabel} from '../public/dashboard.js';
import {mobiusPoint} from '../public/orb.js';
const fixture={current:{temperature_2m:14,weather_code:0,wind_speed_10m:12},daily:{time:['2026-11-05'],weather_code:[0],temperature_2m_max:[19],temperature_2m_min:[10],precipitation_probability_max:[0]}};
test('weather uses only fixed Laishan coordinates, shares concurrent requests and caches successful data',async()=>{
 let calls=0,url,clock=1000;const weather=new WeatherForecast({now:()=>clock,fetcher:async u=>{calls++;url=u;return {ok:true,json:async()=>fixture};}});
 const [a,b]=await Promise.all([weather.read(),weather.read()]);assert.equal(calls,1);assert.equal(a.city,'烟台 · 莱山');assert.equal(url.searchParams.get('latitude'),String(LAISHAN.latitude));assert.equal(url.searchParams.get('longitude'),String(LAISHAN.longitude));assert.equal(b.current.temperature,14);await weather.read();assert.equal(calls,1);clock+=900001;await weather.read();assert.equal(calls,2);
});
test('weather outages retain clearly stale recent data and never invent current temperatures',async()=>{
 let clock=0,fail=false;const w=new WeatherForecast({now:()=>clock,fetcher:async()=>{if(fail)throw new Error('offline');return {ok:true,json:async()=>fixture};}});await w.read();fail=true;clock=900001;assert.equal((await w.read()).stale,true);clock=7200001;await assert.rejects(w.read(),/无法更新/);
});
test('the project list keeps native task titles, pin order and multiple topics in the same folder',()=>{
 const grouped=groupProjects([
  {id:'local',title:'2026-11-05-17-56-08',cwd:'C:/WorkBuddy/2026-11-05-17-56-08',registered:true},
  {id:'buddy',title:'整理视频口播稿和资料',cwd:'c:/workbuddy/2026-11-05-17-56-08/',conversation:true,nativeProject:true,updatedAt:4},
  {id:'pin2',title:'PI搭建codex篇',cwd:'C:/PI/',conversation:true,pinned:true,pinOrder:2,updatedAt:10},
  {id:'pin1',title:'优化 Personal Pi 四项体验',cwd:'c:/pi',conversation:true,pinned:true,pinOrder:1,updatedAt:1},
  {id:'route',title:'读取并续接聊天记录',cwd:'c:/pi',conversation:true,updatedAt:3},
  {id:'noise',title:'files-mentioned-by-the-user-codex',cwd:'D:/files-mentioned-by-the-user-codex'},
 ]);
 assert.deepEqual(grouped.map(({id,displayTitle})=>[id,displayTitle]),[
  ['pin1','优化 Personal Pi 四项体验'],['pin2','PI搭建codex篇'],['local','整理视频口播稿和资料'],['route','读取并续接聊天记录'],
 ]);
 assert.equal(grouped.find(entry=>entry.id==='local').cwd,'C:/WorkBuddy/2026-11-05-17-56-08');
 assert.equal(weatherLabel(95),'雷雨');
});
test('Mobius ribbon joins with exactly one half-twist and remains finite across the surface',()=>{
 for(let i=0;i<20;i++){const u=i*.17,v=(i/20-.5)*.8,a=mobiusPoint(u,v),b=mobiusPoint(u+Math.PI*2,-v);for(const axis of ['x','y','z'])assert.ok(Math.abs(a[axis]-b[axis])<1e-10);assert.ok(Object.values(a).every(Number.isFinite));}
});
