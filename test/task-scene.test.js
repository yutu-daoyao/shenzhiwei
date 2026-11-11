import test from 'node:test';
import assert from 'node:assert/strict';
import {sceneForState,sceneForText} from '../public/task-scene.js';
import {sceneGeometry,ribbonPoint} from '../public/orb.js';
const state=(text,status='running',id='u')=>({currentId:'session',task:{status},items:[{id,type:'userMessage',text}]});
test('only active navigation uses the city visual',()=>{
 assert.equal(sceneForState(state('导航去图书馆')),'city');
 assert.equal(sceneForState(state('导航去图书馆','completed')),'mobius');
 assert.equal(sceneForState(state('查看项目文件')),'mobius');
 assert.equal(sceneForState(state('知微，帮我打开导航')),'city');
 assert.equal(sceneForState(state('请打开导航栏组件')),'mobius');
 assert.equal(sceneForState(state('规划代码迁移路线')),'mobius');
});
test('opening old history never replays navigation',()=>{
 const old=state('请打开导航','completed');
 assert.equal(sceneForState(old),'mobius');
 old.items[0].turnId='old-turn';old.task={status:'starting',turnId:null};
 assert.equal(sceneForState(old),'mobius');
 assert.equal(sceneForText('请整理项目目录'),'mobius');
 assert.equal(sceneForText('directions to the library'),'city');
});
test('scene geometries share finite point identities and fill a real depth range',()=>{
 const shapes=['mobius','city'].map(sceneGeometry);
 for(const points of shapes){assert.equal(points.length,32768*3);assert.ok(points.every(Number.isFinite));const depths=[];for(let i=2;i<points.length;i+=3)depths.push(points[i]);assert.ok(Math.max(...depths)-Math.min(...depths)>.5);}
 assert.notDeepEqual(shapes[0],shapes[1]);assert.notDeepEqual(shapes[1],shapes[2]);
});
test('streamed requests and native replies select the city only for the navigation turn',()=>{
 const v=state('帮我','idle');
 assert.equal(sceneForState(v),'mobius');
 v.items[0].text='帮我查看项目';v.task.status='running';assert.equal(sceneForState(v),'mobius');
 v.items[0].text='导航到图书馆';assert.equal(sceneForState(v),'city');
 v.task.status='interrupted';assert.equal(sceneForState(v),'mobius');
 const native=state('你好','idle','first');native.items.push({id:'answer',type:'agentMessage',text:'你好'});native.realtime={status:'connected'};
 assert.equal(sceneForState(native),'mobius');native.items.push({id:'next',type:'userMessage',text:'帮我导航'});assert.equal(sceneForState(native),'city');
 native.items.push({id:'new-answer',type:'agentMessage',text:'这是路线示意'});assert.equal(sceneForState(native),'mobius');
});
test('the figure-eight ribbon closes with one half-twist and has separated crossing depths',()=>{
 for(let i=0;i<20;i++){const u=i*.3,v=.21,a=ribbonPoint(u,v),b=ribbonPoint(u+Math.PI*2,-v);for(const axis of ['x','y','z'])assert.ok(Math.abs(a[axis]-b[axis])<1e-9);}
 const front=ribbonPoint(0,0),back=ribbonPoint(Math.PI,0);assert.ok(Math.abs(front.x-back.x)<1e-8);assert.ok(Math.abs(front.y-back.y)<1e-8);assert.ok(front.z-back.z>1);
});
