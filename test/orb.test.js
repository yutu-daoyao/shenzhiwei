import test from 'node:test';
import assert from 'node:assert/strict';
import { OrbSignal, simulationMode, simulatedVoice, mountOrb } from '../public/orb.js';
import {artworkPoint,artworkFlow,paintArtworkLights} from '../public/artwork-motion.js';

test('reference artwork has local deformation and moving lights; reduced motion stops the flow', () => {
  {
    const scene='mobius';
    const a=artworkPoint(scene,.3,.3,0),b=artworkPoint(scene,.3,.3,2);
    assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>.003);
    for(let time=0;time<60;time++){
      const p=artworkPoint(scene,.5,.5,time,1);
      assert.ok(Math.abs(p.x-.5)<.05&&Math.abs(p.y-.5)<.08);
    }
  }
  assert.deepEqual(artworkFlow('city',0),{x:.315,y:.737});
  const end=artworkFlow('city',1);assert.ok(Math.hypot(end.x-.699,end.y-.414)<.00001);
  for(const scene of ['mobius','city']){
    const positions=[],ctx=new Proxy({}, {get:(_t,key)=>key==='arc'?(...args)=>positions.push(args):()=>{},set:()=>true});
    const options={w:900,h:450,time:0};
    const count=paintArtworkLights(ctx,scene,options),first=positions[0];positions.length=0;
    paintArtworkLights(ctx,scene,{...options,time:2});assert.notDeepEqual(positions[0],first);
    assert.ok(paintArtworkLights(ctx,scene,{...options,tier:2})<count);
    positions.length=0;assert.equal(paintArtworkLights(ctx,scene,{...options,reduced:true}),0);assert.equal(positions.length,0);
  }
});

test('orb simulation accepts only supported modes and cycles every 3.6 seconds', () => {
  for (const mode of ['idle', 'listening', 'speaking', 'cycle']) assert.equal(simulationMode(`?orbSim=${mode}`), mode);
  assert.equal(simulationMode('?orbSim=unknown'), null);
  assert.deepEqual([0, 3599, 3600, 7200, 10800].map(t => simulatedVoice('cycle', t).state), ['idle', 'idle', 'listening', 'speaking', 'idle']);
  for (let t = 0; t < 12000; t += 17) {
    const voice = simulatedVoice('speaking', t);
    assert.ok(voice.level >= 0 && voice.level <= 1);
  }
});

test('orb colors and shape interpolate over 300ms including rapid reversals', () => {
  const signal = new OrbSignal(), idle = [...signal.profile];
  signal.setVoice({ state:'speaking' }, 0);
  assert.deepEqual(signal.sampleProfile(0), idle);
  const middle = [...signal.sampleProfile(150)];
  assert.ok(middle[0] > idle[0] && middle[0] < 255);
  signal.setVoice({ state:'listening' }, 150);
  assert.deepEqual(signal.sampleProfile(150), middle);
  const listening = signal.sampleProfile(450);
  assert.deepEqual(listening.slice(0, 3), [195, 217, 226]);
  assert.ok(listening[4] > middle[4]);
});

test('orb breath repeats at four seconds and interruption survives coalesced idle snapshots', () => {
  const signal = new OrbSignal();
  assert.ok(Math.abs(signal.sample(1000, 16).scale - signal.sample(5000, 16).scale) < 1e-10);
  signal.setVoice({ state:'idle', interruptedAt:12345 }, 6000);
  assert.ok(signal.sample(6300, 16).scale < 0.85);
  assert.ok(signal.sample(6600, 16).scale > 0.9);
  signal.setVoice({ state:'idle', interruptedAt:12345 }, 7000);
  assert.equal(signal.interruptedAt, 6000, 'the same pulse is not replayed');
});

test('orb honors real silence, follows microphone RMS, and falls back only for missing/stale levels', () => {
  const signal = new OrbSignal();
  signal.setVoice({ state:'listening', level:0, levelAt:100 }, 0);
  assert.equal(signal.sample(100, 100).energy, 0, 'real silence must not become fake speech');
  signal.setVoice({ state:'listening', level:0.1, levelAt:200 }, 200);
  assert.ok(signal.sample(300, 100).energy > 0.3);
  signal.setVoice({ state:'listening', level:0, levelAt:300 }, 300);
  for (let i = 0; i < 30; i++) signal.sample(500, 50);
  assert.ok(signal.energy < 0.001);
  assert.ok(signal.sample(1500, 100).energy > 0.01, 'stale telemetry has a smooth fallback');
});

test('renderer bounds DPR, draws all three states and stops scheduling frames while hidden', t => {
  let draw, visibility, scheduled = 0, cancelled = 0, disconnected = false, strokes = 0;
  const ctx = new Proxy({}, { get(_target, name) {
    if (name === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (name === 'stroke') return () => { strokes++; };
    return () => {};
  }, set() { return true; } });
  const canvas = { getContext:() => ctx, getBoundingClientRect:() => ({ width:800, height:600 }) };
  let output, removed = false;
  const doc = { body:{ append(node) { output = node; } }, createElement:() => ({ setAttribute() {}, remove() { removed = true; } }), hidden:false, addEventListener(_type, listener) { visibility = listener; }, removeEventListener() {} };
  const replace = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable:true, writable:true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  };
  replace('document', doc);
  replace('devicePixelRatio', 3);
  replace('matchMedia', () => ({ matches:false }));
  replace('ResizeObserver', class { observe() {} disconnect() { disconnected = true; } });
  replace('requestAnimationFrame', callback => { scheduled++; draw = callback; return scheduled; });
  replace('cancelAnimationFrame', () => { cancelled++; });
  const stage = { dataset:{} }, label = {};
  const orb = mountOrb({ canvas, stage, label, showFps:true });
  assert.equal(canvas.width, 1600); assert.equal(canvas.height, 1200);
  let time = performance.now() + 100;
  for (const state of ['idle', 'listening', 'speaking']) {
    orb.setVoice({ state, level:0.2, levelAt:time }); draw(time += 350);
    assert.equal(stage.dataset.state, state);
  }
  assert.ok(strokes > 0);
  assert.equal(output.id, 'orb-fps'); assert.match(output.textContent, /FPS/);
  assert.equal(globalThis.__orbStats.particles, 32768);
  doc.hidden = true; visibility(); const before = scheduled; draw(time += 350);
  assert.equal(scheduled, before);
  doc.hidden = false; visibility(); assert.equal(scheduled, before + 1);
  orb.destroy(); assert.equal(disconnected, true); assert.ok(cancelled > 0); assert.equal(removed, true);
});

test('FPS uses rendered cadence and adapts twice under sustained slow frames; hidden gaps are excluded', async () => {
  const { OrbPerformance } = await import('../public/orb.js');
  const meter = new OrbPerformance();
  for (let i = 0; i <= 120; i++) meter.record(i * 1000 / 60, 4, 1000 / 60);
  assert.ok(Math.abs(meter.stats.fps - 60) < 0.2);
  assert.ok(Math.abs(meter.stats.avgFrameMs - 16.67) < 0.1);
  assert.equal(meter.stats.particles, 1024);
  let time = 2000;
  for (let i = 0; i < 65; i++) meter.record(time += 55, 18, 1000 / 30);
  assert.equal(meter.tier, 2); assert.equal(meter.stats.particles, 256);
  meter.reset();
  for (let i = 0; i <= 60; i++) meter.record(90000 + i * 1000 / 30, 3, 1000 / 30);
  assert.ok(Math.abs(meter.stats.fps - 30) < 0.2);
  const reduced = new OrbPerformance();
  for (let i = 0; i < 90; i++) reduced.record(i * 1000 / 30, 3, 1000 / 30);
  assert.equal(reduced.tier, 0, 'intentional 30fps is not mistaken for overload');
});

test('all voice states map to finite distinct profiles, with safe fallback for malformed state', () => {
  const signal = new OrbSignal(), colors = new Set(); let now = 0;
  for (const state of ['idle', 'listening', 'speaking', 'thinking', 'interrupted']) {
    signal.setVoice({ state }, now); const result = signal.sample(now + 300, 16);
    assert.equal(signal.state, state); assert.ok(result.profile.every(Number.isFinite));
    if (state !== 'interrupted') colors.add(result.profile.slice(0, 3).join(','));
    now += 600;
  }
  assert.equal(colors.size, 4);
  for (const voice of [null, {}, { state:'constructor' }, { state:'toString' }, { state:'unknown' }]) {
    signal.setVoice(voice, now += 400); assert.equal(signal.state, 'idle');
  }
});

test('simulation parser handles missing, encoded, duplicate and unsupported parameters deterministically', () => {
  for (const search of ['', '?orbSim=', '?orbSim=Listening', '?orbSim=thinking', '?orbSim=%3Cscript%3E']) assert.equal(simulationMode(search), null);
  assert.equal(simulationMode('?orbFps=1&orbSim=listening&unused=1'), 'listening');
  assert.equal(simulationMode('?orbSim=%73peaking'), 'speaking');
  assert.equal(simulationMode('?orbSim=idle&orbSim=speaking'), 'idle');
});

test('stale volume samples cannot overwrite fresh RMS and out of range levels are bounded', () => {
  const signal = new OrbSignal();
  signal.setVoice({ state:'speaking', level:2, levelAt:100 }, 0); assert.equal(signal.level, 1);
  signal.setVoice({ state:'speaking', level:0, levelAt:99 }, 1); assert.equal(signal.level, 1);
  signal.setVoice({ state:'speaking', level:NaN, levelAt:101 }, 2); assert.equal(signal.level, 1);
  signal.setVoice({ state:'speaking', level:-1, levelAt:102 }, 3); assert.equal(signal.level, 0);
});

test('missing or failing Canvas keeps the rest of the application mountable', () => {
  for (const getContext of [() => null, () => { throw new Error('Canvas unavailable'); }]) {
    const label = {};
    const orb = mountOrb({ canvas:{ getContext }, label });
    assert.match(label.textContent, /无法显示/); assert.equal(globalThis.__orbStats.particles, 0);
    assert.doesNotThrow(() => { orb.setVoice({ state:'listening' }); orb.destroy(); });
  }
});
