// Standalone WebGL renderer with Canvas fallback. No device access.
import {artworkPoint, createArtworkSurface, paintArtworkLights} from './artwork-motion.js';
const TAU = Math.PI * 2;
const clamp = value => Math.max(0, Math.min(1, value));
const profiles = {
  idle: [213, 198, 160, 0.04, 0.68, 0.16],
  thinking: [167, 186, 214, 0.07, 0.72, 0.28],
  listening: [195, 217, 226, 0.22, 0.98, 0.35],
  speaking: [235, 217, 177, 0.28, 0.44, 0.42],
  interrupted: [171, 187, 205, 0.02, 0.68, 0.12],
};
export const orbLabels = { idle:'静候你的声音', listening:'正在聆听', speaking:'正在说话', thinking:'正在思考', interrupted:'已打断' };
export function simulationMode(search) {
  const mode = new URLSearchParams(search).get('orbSim');
  return ['idle', 'listening', 'speaking', 'cycle'].includes(mode) ? mode : null;
}
export function simulatedVoice(mode, elapsedMs) {
  const state = mode === 'cycle' ? ['idle', 'listening', 'speaking'][Math.floor(elapsedMs / 3600) % 3] : mode;
  const t = elapsedMs / 1000;
  return { state, level:state === 'idle' ? 0 : (0.035 + 0.15 * clamp(0.5 + Math.sin(t * 4.3) * 0.3 + Math.sin(t * 9.7) * 0.2)), levelAt:elapsedMs + 1 };
}

export class OrbSignal {
  constructor() {
    this.state = 'idle'; this.profile = [...profiles.idle]; this.from = [...this.profile];
    this.changedAt = -Infinity; this.interruptedAt = -Infinity;
    this.levelSeenAt = -Infinity; this.levelStamp = 0; this.level = 0; this.energy = 0;
    this.interruptStamp = 0;
  }
  setVoice(voice = {}, now = performance.now()) {
    voice ??= {};
    if (voice.interruptedAt > this.interruptStamp) {
      this.interruptStamp = voice.interruptedAt; this.interruptedAt = now;
    }
    const state = Object.hasOwn(profiles, voice.state) ? voice.state : 'idle';
    if (state !== this.state) {
      this.sampleProfile(now); this.from = [...this.profile]; this.state = state; this.changedAt = now;
      this.levelSeenAt = -Infinity; this.levelStamp = 0;
      if (state === 'interrupted') this.interruptedAt = now;
    }
    if (Number.isFinite(voice.level) && voice.levelAt > this.levelStamp) {
      this.level = clamp(voice.level); this.levelStamp = voice.levelAt; this.levelSeenAt = now;
    }
  }
  sampleProfile(now) {
    const progress = clamp((now - this.changedAt) / 300);
    const ease = progress * progress * (3 - 2 * progress);
    this.profile = profiles[this.state].map((target, i) => this.from[i] + (target - this.from[i]) * ease);
    return this.profile;
  }
  sample(now, dt) {
    const profile = this.sampleProfile(now), t = now / 1000;
    const active = this.state === 'listening' || this.state === 'speaking';
    const fallback = 0.24 + 0.17 * Math.sin(t * 3.7) + 0.09 * Math.sin(t * 8.1 + 1);
    const target = active ? (now - this.levelSeenAt < 600 ? clamp(Math.pow(this.level * 6, 0.75)) : clamp(fallback)) : 0;
    this.energy += (target - this.energy) * (1 - Math.exp(-dt / (target > this.energy ? 65 : 170)));
    const contraction = 0.22 * Math.sin(clamp((now - this.interruptedAt) / 600) * Math.PI);
    const breath = Math.sin(t * TAU / (this.state === 'thinking' ? 2.7 : 4));
    return { profile, energy:this.energy, scale:1 + breath * 0.035 + this.energy * profile[3] - contraction };
  }
}

// Actual rendered-frame cadence, including skipped RAF callbacks. Hidden time is excluded.
export class OrbPerformance {
  constructor() {
    this.stats = { fps:0, avgFrameMs:0, particles:1024 };
    this.tier = 0; this.reset();
  }
  reset() { this.last = null; this.elapsed = 0; this.frames = 0; this.slow = 0; }
  record(now, cost, targetMs) {
    const gap = this.last === null ? 0 : now - this.last;
    this.last = now;
    if (gap > 0) { this.elapsed += gap; this.frames++; }
    this.slow = cost > 14 || gap > targetMs * 1.45 ? this.slow + 1 : Math.max(0, this.slow - 1);
    let degraded = false;
    if (this.slow >= 30 && this.tier < 2) {
      this.tier++; this.slow = 0; degraded = true;
      this.stats.particles = 1024 / (2 ** this.tier);
    }
    if (this.elapsed >= 1000) {
      this.stats.avgFrameMs = Number((this.elapsed / this.frames).toFixed(2));
      this.stats.fps = Number((1000 * this.frames / this.elapsed).toFixed(1));
      this.elapsed = 0; this.frames = 0;
    }
    return degraded;
  }
}

// One half-twist: (u + 2π, -v) joins (u, v), a single continuous surface.
export function mobiusPoint(u,v){const radius=1+v*Math.cos(u/2);return {x:radius*Math.cos(u),y:radius*Math.sin(u),z:v*Math.sin(u/2)};}

const COUNT = 32768;
const fraction = n => { const value = Math.sin(n * 127.1 + 31.7) * 43758.5453; return value - Math.floor(value); };
export const sceneNames = { mobius:'莫比乌斯 · 待机', city:'城市与路线示意' };

// A closed spatial figure-eight with a single half-twist across the ribbon.
export function ribbonPoint(u,v) {
  v *= (.75 + .25*Math.cos(u)**2)*(1+.22*Math.sin(u));
  const dx = 1.65*Math.cos(u), dy = 1.04*Math.cos(2*u)+.09*Math.cos(u), dz = -.78*Math.sin(u);
  const length = Math.hypot(dx,dy,dz), planar = Math.hypot(dx,dy);
  const nx = -dy/planar, ny = dx/planar;
  const bx = -dz*ny/length, by = dz*nx/length, bz = (dx*ny-dy*nx)/length;
  const a = v*Math.cos(u/2+.65), b = v*Math.sin(u/2+.65);
  return {x:1.65*Math.sin(u)+a*nx+b*bx,y:(.52*Math.sin(2*u)+.09*Math.sin(u)+a*ny+b*by)*.78*(1+.16*Math.max(0,Math.sin(u))),z:.78*Math.cos(u)+b*bz};
}

// Both shapes share point indices, so a change morphs the existing stars.
export function sceneGeometry(scene) {
  const points = new Float32Array(COUNT * 3);
  const put = (i, x, y, z) => points.set([x,y,z], i * 3);
  for (let i = 0; i < COUNT; i++) {
    const a = fraction(i + 1), b = fraction(i + 1701), c = fraction(i + 409);
    if (scene === 'city') {
      if (i < COUNT * .19) {
        const route = a * Math.PI;
        put(i, (a - .5) * 2.45, -.36 + b * .012, .32 * Math.sin(route * 2) + .19);
      } else if (i < COUNT * .35) {
        // The ground grid, with open streets between the buildings.
        const line = Math.floor(a * 9);
        put(i, i % 2 ? (line - 4) * .29 : (b - .5) * 2.55, -.39, i % 2 ? (b - .5) * 1.9 : (line - 4) * .23);
      } else {
        const building = Math.floor(a * 30), col = building % 6, row = Math.floor(building / 6);
        const h = .15 + fraction(building + 91) * .62 + (building === 14 ? .45 : 0);
        let x = (col - 2.5) * .37, z = (row - 2) * .31;
        const side = i % 5, w = .095, d = .087;
        let y = -.37 + b * h;
        if (side === 4) { x += (b - .5) * w * 2; z += (c - .5) * d * 2; y = -.37 + h; }
        else if (side < 2) { x += side ? w : -w; z += (c - .5) * d * 2; }
        else { z += side === 2 ? d : -d; x += (c - .5) * w * 2; }
        put(i,x,y,z);
      }
    } else {
      // More grains accumulate along the luminous edges; loose dust floats beyond them.
      const v = i % 12 === 0 ? Math.sign(b-.5) * (.83 + c*.17) : (b-.5)*2;
      const q = ribbonPoint(a * TAU,v * .61);
      const dust = i % 9 === 0 ? .38 : .018;
      put(i,q.x+(c-.5)*dust,q.y+(fraction(i+8)-.5)*dust,q.z+(fraction(i+17)-.5)*dust);
    }
  }
  return points;
}


// Native GPU blending keeps thousands of luminous grains smooth without a library.
function ribbonGPU(stage) {
  if(!stage.append)return null;
  const canvas=document.createElement('canvas');canvas.className='orb-gl';canvas.setAttribute('aria-hidden','true');
  let gl;try{gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:true,depth:false});}catch{}
  if(!gl)return null;
  const vert=`
    attribute vec3 aFrom;attribute vec3 aTo;attribute vec2 aUV;attribute vec3 aColor;attribute vec2 aMeta;
    uniform float uBlend,uYaw,uPitch,uRoll,uTime,uEnergy,uDPR,uEcho,uRing;uniform vec4 uFit;
    varying vec3 vColor;varying vec2 vUV;varying float vKind,vDepth,vSeed;
    vec3 ribbon(float u,float v,float twist){
      v*=(.75+.25*pow(cos(u),2.))*(1.+.22*sin(u));
      vec3 d=vec3(1.65*cos(u),1.04*cos(2.*u)+.09*cos(u),-.78*sin(u));
      vec2 n=normalize(vec2(-d.y,d.x));
      vec3 b=vec3(-d.z*n.y,d.z*n.x,d.x*n.y-d.y*n.x)/length(d);
      vec3 p=vec3(1.65*sin(u),.52*sin(2.*u)+.09*sin(u),.78*cos(u));
      p+=v*cos(u*.5+.65+twist)*vec3(n,0.)+v*sin(u*.5+.65+twist)*b;p.y*=.78*(1.+.16*max(0.,sin(u)));return p;
    }
    void main(){
      vec3 p=mix(aFrom,aTo,uBlend);
      float u=aUV.x*6.283185;
      if(aMeta.y>.5&&uRing>.001){p+=(ribbon(u+uTime*.035,aUV.y*.61,uEcho*1.2)-ribbon(u,aUV.y*.61,0.))*uRing;}
      if(aMeta.y<.5&&uEcho>.5)p=ribbon(u,aUV.y*.48,1.2);
      if(uEcho>.5){p.y*=.94;p.x*=1.02;}
      p+=vec3(0.,sin(aUV.x*30.+uTime*.45)*.009*(.3+uEnergy)*uRing,0.);
      float x=p.x*cos(uYaw)+p.z*sin(uYaw),z=p.z*cos(uYaw)-p.x*sin(uYaw);
      float y=p.y*cos(uPitch)-z*sin(uPitch),d=p.y*sin(uPitch)+z*cos(uPitch);
      vec2 q=vec2(x*cos(uRoll)-y*sin(uRoll),x*sin(uRoll)+y*cos(uRoll))*4./(4.-d*.40);
      gl_Position=vec4(q.x*uFit.x+uFit.z,q.y*uFit.y+uFit.w,0.,1.);
      gl_PointSize=aMeta.x*uDPR*(1.+uEnergy*.22);
      vColor=aColor;vUV=aUV;vKind=aMeta.y;vDepth=d;vSeed=aMeta.x;
    }`;
  const frag=`
    precision highp float;varying vec3 vColor;varying vec2 vUV;varying float vKind,vDepth,vSeed;
    uniform float uTime,uAlpha,uState,uEcho,uRing;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    void main(){
      vec3 color=vColor;
      color=mix(color,vec3(.51,.73,1.),uEcho*.66);
      color=mix(color,vec3(.68,.81,.98),uState*.27);
      float alpha;
      if(vKind<.5){
        float edge=exp(-pow((abs(vUV.y)-.985)*75.,2.));
        float shoulder=exp(-pow((abs(vUV.y)-.91)*7.,2.));
        float fold=exp(-pow((vUV.y-.38*sin(vUV.x*12.566)) * 7.,2.));
        float filament=pow(.5+.5*sin(vUV.y*108.+sin(vUV.x*25.)*1.1),30.);
        float thread=exp(-pow((vUV.y-.40*sin(vUV.x*9.424+uTime*.10))*90.,2.));
        float silk=.025+.12*shoulder+.065*fold+.008*filament+thread*.18;
        float grain=hash(floor(vec2(vUV.x*1800.,vUV.y*240.)));
        float sparkle=pow(grain,23.)*(.5+.5*sin(vUV.x*80.+uTime*.8));
        alpha=(silk+edge*.22+sparkle*.32)*uAlpha;
        color=mix(color,vec3(1.,.91,.72),edge*.20);
      }else{
        vec2 q=gl_PointCoord-.5;float r=length(q);
        if(vKind>2.5){float ray=exp(-abs(q.x)*100.)*exp(-abs(q.y)*7.)+exp(-abs(q.y)*100.)*exp(-abs(q.x)*7.);alpha=(exp(-r*r*180.)+ray*.5)*uAlpha;}
        else{alpha=(exp(-r*r*48.)+exp(-r*r*10.)*.12)*uAlpha;}
        alpha*=.75+.25*sin(vUV.x*190.+vSeed*28.+uTime*(.4+vSeed*.13));
        if(vKind<2.5)alpha*=mix(.25,1.35,smoothstep(1.6,4.4,vSeed));
        color=mix(color,vec3(1.,.96,.87),.06);
        if(alpha<.006)discard;
      }
      alpha*=mix(1.,.64+.36*smoothstep(-.8,.8,vDepth),uRing);
      gl_FragColor=vec4(color,alpha);
    }`;
  function compile(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;}
  let program;
  try{program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vert));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,frag));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('GPU shader link failed');}
  catch{canvas.remove();return null;}
  gl.useProgram(program);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.disable(gl.DEPTH_TEST);
  const attributes=['aFrom','aTo','aUV','aColor','aMeta'].map(n=>gl.getAttribLocation(program,n));
  const uniforms=Object.fromEntries(['uBlend','uYaw','uPitch','uRoll','uTime','uEnergy','uDPR','uFit','uAlpha','uState','uEcho','uRing'].map(n=>[n,gl.getUniformLocation(program,n)]));
  function buffer(data){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);return b;}
  function bind(b){gl.bindBuffer(gl.ARRAY_BUFFER,b);let offset=0;for(let i=0;i<5;i++){gl.enableVertexAttribArray(attributes[i]);const size=[3,3,2,3,2][i];gl.vertexAttribPointer(attributes[i],size,gl.FLOAT,false,52,offset*4);offset+=size;}}
  function tint(u,v=0){const t=clamp(.5+.42*Math.sin(u+.3)+v*.30);return [.40+.60*t,.68+.16*t,1.-.42*t];}
  const surface=[];
  function surfaceVertex(u,v){const p=ribbonPoint(u,v*.61);surface.push(p.x,p.y,p.z,p.x,p.y,p.z,u/TAU,v,...tint(u,v),1,0);}
  for(let i=0;i<320;i++)for(let j=0;j<32;j++){
    const u=i/320*TAU,next=(i+1)/320*TAU,v=j/32*2-1,w=(j+1)/32*2-1;
    surfaceVertex(u,v);surfaceVertex(next,v);surfaceVertex(next,w);surfaceVertex(u,v);surfaceVertex(next,w);surfaceVertex(u,w);
  }
  const surfaceBuffer=buffer(new Float32Array(surface));let pointBuffer=null,pointData=new Float32Array(COUNT*13);
  function morph(from,to){
    for(let i=0;i<COUNT;i++){
      const k=i*3,o=i*13,u=fraction(i+1)*TAU,b=fraction(i+1701),v=i%12===0?Math.sign(b-.5)*(.83+fraction(i+409)*.17):(b-.5)*2;
      pointData.set([from[k],from[k+1],from[k+2],to[k],to[k+1],to[k+2],u/TAU,v,...(i%5===0?[1,.85,.62]:tint(u,v)),i%1297===0?22:1.1+Math.pow(fraction(i+31),3)*4.5,i%1297===0?3:1],o);
    }
    if(!pointBuffer)pointBuffer=buffer(pointData);else{gl.bindBuffer(gl.ARRAY_BUFFER,pointBuffer);gl.bufferData(gl.ARRAY_BUFFER,pointData,gl.STATIC_DRAW);}
  }
  // A small separable bloom keeps bright dust surrounded by light rather than a hard outline.
  const post=gl.createProgram();
  gl.attachShader(post,compile(gl.VERTEX_SHADER,'attribute vec2 aPosition;varying vec2 vUV;void main(){vUV=aPosition*.5+.5;gl_Position=vec4(aPosition,0.,1.);}'));
  gl.attachShader(post,compile(gl.FRAGMENT_SHADER,`
    precision mediump float;varying vec2 vUV;uniform sampler2D uImage,uBase;uniform vec2 uStep;uniform float uComposite;
    void main(){
      vec4 light=texture2D(uImage,vUV)*.227027;
      light+=(texture2D(uImage,vUV+uStep*1.384615)+texture2D(uImage,vUV-uStep*1.384615))*.316216;
      light+=(texture2D(uImage,vUV+uStep*3.230769)+texture2D(uImage,vUV-uStep*3.230769))*.070270;
      if(uComposite>.5){vec4 base=texture2D(uBase,vUV);gl_FragColor=vec4(base.rgb+light.rgb*.65,max(base.a,light.a*.8));}
      else gl_FragColor=light;
    }`));
  gl.linkProgram(post);
  const postPosition=gl.getAttribLocation(post,'aPosition'),postStep=gl.getUniformLocation(post,'uStep'),postComposite=gl.getUniformLocation(post,'uComposite');
  const quad=buffer(new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]));
  const textures=[gl.createTexture(),gl.createTexture()],frames=[gl.createFramebuffer(),gl.createFramebuffer()];
  let bloomWidth=1,bloomHeight=1;
  function resizeBloom(w,h){
    bloomWidth=Math.max(1,Math.round(w));bloomHeight=Math.max(1,Math.round(h));
    textures.forEach((texture,i)=>{
      gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,i?Math.ceil(bloomWidth/2):bloomWidth,i?Math.ceil(bloomHeight/2):bloomHeight,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER,frames[i]);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    });gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
  function bloom(){
    gl.disable(gl.BLEND);gl.useProgram(post);attributes.forEach(a=>gl.disableVertexAttribArray(a));
    gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.enableVertexAttribArray(postPosition);gl.vertexAttribPointer(postPosition,2,gl.FLOAT,false,0,0);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,textures[0]);gl.uniform1i(gl.getUniformLocation(post,'uImage'),0);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,textures[0]);gl.uniform1i(gl.getUniformLocation(post,'uBase'),1);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frames[1]);gl.viewport(0,0,Math.ceil(bloomWidth/2),Math.ceil(bloomHeight/2));
    gl.uniform2f(postStep,2.6/bloomWidth,0);gl.uniform1f(postComposite,0);gl.drawArrays(gl.TRIANGLES,0,6);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,bloomWidth,bloomHeight);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,textures[1]);gl.uniform2f(postStep,0,2.6/bloomHeight);gl.uniform1f(postComposite,1);gl.drawArrays(gl.TRIANGLES,0,6);
    gl.disableVertexAttribArray(postPosition);gl.enable(gl.BLEND);gl.activeTexture(gl.TEXTURE0);
  }
  let artworkSurface;try{artworkSurface=createArtworkSurface(gl,compile);}catch{}
  stage.append(canvas);
  return {morph,paintArtwork(asset,name,options){if(!artworkSurface)return false;artworkSurface.draw(asset,name,options);return true;},clear(){gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);},resize(w,h,dpr){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);resizeBloom(canvas.width,canvas.height);gl.viewport(0,0,canvas.width,canvas.height);},draw({w,h,r,cx,cy,yaw,pitch,roll,t,energy,blend,ringAlpha,state,dpr}){
    gl.bindFramebuffer(gl.FRAMEBUFFER,frames[0]);gl.viewport(0,0,bloomWidth,bloomHeight);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(program);
    for(const [name,value] of Object.entries({uYaw:yaw,uPitch:pitch,uRoll:roll,uTime:t,uEnergy:energy,uDPR:dpr,uState:state==='thinking'?1:0,uRing:ringAlpha}))gl.uniform1f(uniforms[name],value);
    gl.uniform4f(uniforms.uFit,r*2/w,r*2/h,cx*2/w-1,1-cy*2/h);
    if(ringAlpha>.002){bind(surfaceBuffer);gl.uniform1f(uniforms.uBlend,1);gl.uniform1f(uniforms.uAlpha,ringAlpha*.45);gl.uniform1f(uniforms.uEcho,1);gl.drawArrays(gl.TRIANGLES,0,surface.length/13);gl.uniform1f(uniforms.uEcho,0);gl.uniform1f(uniforms.uAlpha,ringAlpha);gl.drawArrays(gl.TRIANGLES,0,surface.length/13);}
    if(ringAlpha>.1){bind(pointBuffer);gl.uniform1f(uniforms.uEcho,1);gl.uniform1f(uniforms.uBlend,blend);gl.uniform1f(uniforms.uAlpha,ringAlpha*.24);gl.drawArrays(gl.POINTS,0,COUNT);}
    gl.uniform1f(uniforms.uEcho,0);bind(pointBuffer);gl.uniform1f(uniforms.uBlend,blend);gl.uniform1f(uniforms.uAlpha,ringAlpha>.1?1.18:1.1);gl.drawArrays(gl.POINTS,0,COUNT);
    bloom();
  },destroy(){artworkSurface?.destroy();gl.deleteBuffer(surfaceBuffer);gl.deleteBuffer(pointBuffer);gl.deleteBuffer(quad);textures.forEach(t=>gl.deleteTexture(t));frames.forEach(f=>gl.deleteFramebuffer(f));gl.deleteProgram(post);gl.deleteProgram(program);canvas.remove();}};
}
export function mountOrb({ canvas, label, stage, simulation = null, showFps = false }) {
  let ctx;
  try { ctx = canvas.getContext('2d', { alpha:true }); } catch {}
  if (!ctx) {
    globalThis.__orbStats = { fps:0, avgFrameMs:0, particles:0 };
    label.textContent = '当前环境无法显示光球'; return { setVoice() {}, setScene() {}, destroy() {} };
  }
  const signal = new OrbSignal(), meter = new OrbPerformance(),gpu=ribbonGPU(stage);
  const background=ctx,foreground=gpu?document.createElement('canvas'):null,front=foreground?.getContext('2d');
  if(foreground){foreground.className='orb-foreground';foreground.setAttribute('aria-hidden','true');stage.append(foreground);}
  meter.stats.particles = COUNT; meter.stats.geometry = 'mobius';
  globalThis.__orbStats = meter.stats;
  const hud = showFps ? document.createElement('output') : null;
  if (hud) { hud.id = 'orb-fps'; hud.setAttribute('aria-label','光球帧率'); document.body.append(hud); }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const startedAt = performance.now();
  let width = 0, height = 0, raf = 0, last = 0, renderedAt = 0, disposed = false, currentLabel = '';
  let previousScene='mobius', scene = 'mobius', changedAt = -Infinity, points = sceneGeometry(scene), from = points.slice(), target = points.slice();
  let rotation = 0, sky = null, glow = null;
  const artworks = {};
  if(typeof Image !== 'undefined')for(const name of Object.keys(sceneNames)){
    const asset=new Image();asset.onload=()=>{if(!disposed)artworks[name]=asset;};asset.src=`/scene-${name}.png`;
  }
  function paintArtwork(name,opacity,t,energy){
    const asset=artworks[name];if(!asset||opacity<=0)return;
    const fit=Math.min(width*.99/asset.naturalWidth,(height-18)/asset.naturalHeight);
    const w=asset.naturalWidth*fit,h=asset.naturalHeight*fit;
    const time=reduced.matches?0:t,motionEnergy=reduced.matches?0:energy;
    const accelerated=gpu?.paintArtwork(asset,name,{width,height,w,h,time,energy:motionEnergy,opacity});
    ctx.save();ctx.translate(width/2,height*.49);ctx.globalAlpha=opacity;
    if(!accelerated){
      if(name==='mobius')for(let i=0;i<72;i++){
        const x=i/72,p=artworkPoint(name,x,.5,time,motionEnergy),sw=asset.naturalWidth/72;
        ctx.drawImage(asset,i*sw,0,Math.min(sw+1,asset.naturalWidth-i*sw),asset.naturalHeight,(p.x-.5)*w,-h/2+(p.y-.5)*h,w/72+.7,h);
      }
      else ctx.drawImage(asset,-w/2,-h/2,w,h);
    }
    const liveParticles=paintArtworkLights(ctx,name,{w,h,time,energy:motionEnergy,opacity,reduced:reduced.matches,tier:meter.tier,glow});
    ctx.restore();return liveParticles;
  }
  gpu?.morph(from,target);
  const buckets = Array.from({length:9},()=>[]);
  const colors = ['255,218,169','235,242,250','147,199,247'];
  function resize() {
    const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, meter.tier ? 1.25 : 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    background.setTransform(dpr,0,0,dpr,0,0);
    gpu?.resize(width,height,dpr);
    if(front){foreground.width=canvas.width;foreground.height=canvas.height;front.setTransform(dpr,0,0,dpr,0,0);}
    sky = makeSky(width,height);
    if(!glow)glow = makeGlow();
  }
  const observer = new ResizeObserver(resize); observer.observe(canvas);
  function makeGlow() {
    const c=document.createElement('canvas'),g=c.getContext?.('2d');if(!g)return null;
    c.width=64;c.height=64;const light=g.createRadialGradient(32,32,0,32,32,32);
    light.addColorStop(0,'rgba(255,249,229,1)');light.addColorStop(.06,'rgba(255,231,191,.9)');light.addColorStop(.22,'rgba(233,194,133,.20)');light.addColorStop(1,'rgba(233,194,133,0)');g.fillStyle=light;g.fillRect(0,0,64,64);return c;
  }
  function makeSky(w,h) {
    const c=document.createElement('canvas'),g=c.getContext?.('2d');if(!g||!w||!h)return null;
    c.width=w;c.height=h;
    // Cached galactic dust is painted once per resize, not rebuilt every frame.
    for(let i=0;i<270;i++){
      const t=fraction(i+5),x=w*(.18+t*.70),y=h*(-.18+t*1.4)+(fraction(i+83)-.5)*h*.28,r=12+fraction(i+11)*w*.08;
      const cloud=g.createRadialGradient(x,y,0,x,y,r);cloud.addColorStop(0,`rgba(89,143,201,${.015+fraction(i+46)*.027})`);cloud.addColorStop(1,'rgba(31,64,104,0)');g.fillStyle=cloud;g.fillRect(x-r,y-r,r*2,r*2);
    }
    for(let i=0;i<2600;i++){
      const x=fraction(i+12000)*w,y=fraction(i+19000)*h,band=Math.exp(-Math.pow((y/h-(x/w-.16)*1.6)/.12,2));
      const a=.07+fraction(i+34)*.44+band*.22,size=i%37===0?1.05:.25+fraction(i+902)*.55;
      g.fillStyle=`rgba(${i%5?'169,199,228':'244,222,183'},${a})`;g.beginPath();g.arc(x,y,size,0,TAU);g.fill();
    }
    return c;
  }
  function drawSilk(project,blend,energy) {
    const strips=[];
    // Translucent ribbons and luminous filaments make a surface, not an outline.
    for(let lane=0;lane<42;lane++){
      const v=(lane/41-.5)*.70,vertices=[];let depth=0;
      for(let j=0;j<=156;j++){const p=ribbonPoint(j/156*TAU,v),q=project(p.x,p.y,p.z);vertices.push(q);depth+=q.z;}
      strips.push({vertices,depth:depth/157,v,lane});
    }
    strips.sort((a,b)=>a.depth-b.depth);
    ctx.save();ctx.globalCompositeOperation='screen';
    for(const strip of strips){
      const edge=Math.pow(Math.abs(strip.v)/.35,6),color=strip.v>0?'255,222,182':'155,207,255';
      ctx.beginPath();strip.vertices.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
      ctx.strokeStyle=`rgba(${color},${(.025+edge*.025)*blend})`;ctx.lineWidth=5.5;ctx.stroke();
      ctx.strokeStyle=`rgba(${color},${(.09+edge*.36+energy*.04)*blend})`;ctx.lineWidth=edge>.8?1.25:.4;ctx.stroke();
    }
    // Three flowing light threads trace the same band, with a soft halo.
    for(let lane=0;lane<3;lane++){
      const v=(lane-1)*.22;ctx.beginPath();
      for(let j=0;j<=230;j++){const u=j/230*TAU,p=ribbonPoint(u,v+Math.sin(u*3+lane)*.045),q=project(p.x,p.y,p.z);if(!j)ctx.moveTo(q.x,q.y);else ctx.lineTo(q.x,q.y);}
      ctx.strokeStyle=`rgba(${lane===1?'222,235,250':'255,221,181'},${.07*blend})`;ctx.lineWidth=9;ctx.stroke();
      ctx.strokeStyle=`rgba(${lane===1?'222,235,250':'255,221,181'},${.65*blend})`;ctx.lineWidth=.85;ctx.stroke();
    }
    ctx.restore();
  }
  function setScene(value) {
    value = Object.hasOwn(sceneNames,value) ? value : 'mobius';
    if (scene === value) return;
    previousScene=scene;scene = value; from = points.slice(); target = sceneGeometry(scene); changedAt = performance.now();
    gpu?.morph(from,target);
    stage.dataset.scene = scene; meter.stats.geometry = scene;
  }
  function describe() {
    if (signal.state === currentLabel) return;
    currentLabel = signal.state; stage.dataset.state = signal.state; label.textContent = orbLabels[signal.state];
  }
  function setVoice(voice) { signal.setVoice(voice); describe(); }
  function draw(now) {
    raf = 0;
    if (disposed || document.hidden) return;
    raf = requestAnimationFrame(draw);
    const interval = reduced.matches || meter.tier ? 1000 / 30 : 1000 / 60;
    if (now - renderedAt < interval - 1) return;
    const dt = last ? Math.min(now - last,80) : 16; last = now; renderedAt = now;
    if (simulation) signal.setVoice(simulatedVoice(simulation,now - startedAt),now);
    describe();
    const began = performance.now(), { energy, scale, profile } = signal.sample(now,dt);
    const palette = [signal.state==='thinking'?'190,211,237':colors[0],colors[1],colors[2]];
    const t = now / 1000, progress = clamp((now - changedAt) / (reduced.matches ? 160 : 1600));
    const blend = progress * progress * (3 - 2 * progress);
    const illustrated=!!artworks[scene]&&(blend===1||!!artworks[previousScene]);
    rotation += dt / 1000 * (reduced.matches ? 0 : .085);
    const yaw = scene === 'mobius' ? Math.sin(rotation) * .20 : (scene === 'city' ? .50 : .18) + Math.sin(rotation * .5) * .13;
    const pitch = scene === 'city' ? .58 : .10 * Math.sin(rotation * .7);
    const roll = scene === 'mobius' ? .025 + Math.sin(rotation * .7) * .025 : -.06;
    let r = Math.min(width * .37, (height - 30) * .87, 560) * (1 + (scale - 1) * .4);
    const cx = width / 2, cy = height * .50;
    function project(x,y,z) {
      const rx = x * Math.cos(yaw) + z * Math.sin(yaw), rz = z * Math.cos(yaw) - x * Math.sin(yaw);
      const ry = y * Math.cos(pitch) - rz * Math.sin(pitch), depth = y * Math.sin(pitch) + rz * Math.cos(pitch);
      const perspective = 4 / (4 - depth * .40);
      return { x:cx + (rx * Math.cos(roll) - ry * Math.sin(roll)) * r * perspective, y:cy - (rx * Math.sin(roll) + ry * Math.cos(roll)) * r * perspective, z:depth };
    }
    if(!illustrated)for (let k = 0; k < points.length; k++) points[k] = from[k] + (target[k] - from[k]) * blend;
    let boundX = 1, boundY = 1;
    if(!illustrated)for (let i = 0; i < COUNT; i += 7) {
      const p = project(points[i*3],points[i*3+1],points[i*3+2]);
      boundX = Math.max(boundX,Math.abs(p.x-cx));boundY = Math.max(boundY,Math.abs(p.y-cy));
    }
    r *= Math.min(1,width*.46/boundX,Math.max(1,height-35)*.5/boundY);
    ctx=background;ctx.clearRect(0,0,width,height);
    const atmosphere = ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(1,r * 1.5));
    atmosphere.addColorStop(0,'rgba(68,100,136,.11)'); atmosphere.addColorStop(.6,'rgba(31,61,91,.04)'); atmosphere.addColorStop(1,'rgba(20,40,60,0)');
    ctx.fillStyle = atmosphere; ctx.fillRect(0,0,width,height);
    if(sky)ctx.drawImage(sky,0,0,width,height);
    if (r <= 0) return;
    // Fine galactic dust remains behind the sculpture in every scene.
    for (let i = 0; i < 310; i += 2 ** meter.tier) {
      const a = fraction(i + 10001), b = fraction(i + 12002), x = a * width, y = b * height;
      const alpha = (.12 + fraction(i) * .35) * (.8 + .2 * Math.sin(t * .6 + i));
      ctx.fillStyle = `rgba(${palette[i % 3]},${alpha})`;
      ctx.beginPath(); ctx.arc(x,y,i % 47 ? .35 + a * .5 : 1.1,0,TAU); ctx.fill();
      if (i % 47 === 0) {
        ctx.strokeStyle = `rgba(${colors[0]},${alpha * .6})`; ctx.lineWidth = .5;
        ctx.beginPath();ctx.moveTo(x-4,y);ctx.lineTo(x+4,y);ctx.moveTo(x,y-4);ctx.lineTo(x,y+4);ctx.stroke();
      }
    }
    if(illustrated)gpu?.clear();
    else if(gpu)gpu.draw({w:width,h:height,r,cx,cy,yaw,pitch,roll,t,energy,blend,ringAlpha:scene==='mobius'?blend:previousScene==='mobius'?1-blend:0,state:signal.state,dpr:canvas.width/width});
    if(!gpu&&!illustrated){
    if(scene==='mobius') drawSilk(project,blend,energy);
    for (const bucket of buckets) bucket.length = 0;
    const stars = [], stride = 2 ** meter.tier;
    for (let sample = 0; sample < COUNT; sample += stride) {
      // Keep every face and edge at lower quality; plain i += stride aliases them.
      const i = sample + Math.floor(fraction(sample + 857) * stride);
      const k = i * 3;
      const q = project(points[k],points[k+1],points[k+2]);
      const depth = clamp((q.z + 1.3) / 2.6), layer = Math.min(2,Math.floor(depth * 3));
      const route = scene === 'city' && i < COUNT * .19;
      const warmth = Math.sin(fraction(i+1)*TAU+.6);
      const color = route ? 0 : scene === 'mobius' ? (warmth>.15?0:warmth<-.15?2:1) : i % 7 < 3 ? 0 : i % 7 < 5 ? 1 : 2;
      const size = (.30 + fraction(i + 6000) * .52) * (.65 + depth * .55) * (1 + energy * .18);
      buckets[layer * 3 + color].push(q.x,q.y,size);
      if (i % 211 === 0 && layer > 0) stars.push(q);
    }
    // Back to front layers preserve depth without connecting points into a mesh.
    for (let layer = 0; layer < 3; layer++) for (let color = 0; color < 3; color++) {
      const bucket = buckets[layer * 3 + color];
      ctx.fillStyle = `rgba(${palette[color]},${.44 + layer * .22 + energy * .05})`; ctx.beginPath();
      for (let i = 0; i < bucket.length; i += 3) {ctx.moveTo(bucket[i]+bucket[i+2],bucket[i+1]);ctx.arc(bucket[i],bucket[i+1],bucket[i+2],0,TAU);}
      ctx.fill();
    }
    // A handful of brighter stars, never bloom on every particle.
    for (const q of stars) {
      const shine = .5 + .22 * Math.sin(t * 1.2 + q.x);
      if(glow){ctx.globalCompositeOperation='screen';ctx.globalAlpha=.60;ctx.drawImage(glow,q.x-13,q.y-13,26,26);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';}
      ctx.strokeStyle = `rgba(255,237,205,${shine})`;ctx.lineWidth = .55;
      ctx.beginPath();ctx.moveTo(q.x-3.5,q.y);ctx.lineTo(q.x+3.5,q.y);ctx.moveTo(q.x,q.y-3.5);ctx.lineTo(q.x,q.y+3.5);ctx.stroke();
    }
    }
    if(front){ctx=front;ctx.clearRect(0,0,width,height);}
    let liveParticles=0;
    if(illustrated){if(blend<1)paintArtwork(previousScene,1-blend,t,energy);liveParticles=paintArtwork(scene,blend,t,energy)||0;}
    if (!illustrated && scene === 'city' && blend > .85) {
      const buildings=Array.from({length:30},(_,i)=>i).sort((a,b)=>{
        const depth=i=>project((i%6-2.5)*.37,0,(Math.floor(i/6)-2)*.31).z;
        return depth(a)-depth(b);
      });
      for (const building of buildings) {
        const x = (building%6-2.5)*.37, z = (Math.floor(building/6)-2)*.31;
        const h = .15+fraction(building+91)*.62+(building===14?.45:0), y = -.37;
        const corners = [[x-.095,y,z-.087],[x+.095,y,z-.087],[x+.095,y,z+.087],[x-.095,y,z+.087]];
        const roof = corners.map(p=>[p[0],p[1]+h,p[2]]);
        for(const face of [[...roof],[corners[0],corners[1],roof[1],roof[0]],[corners[1],corners[2],roof[2],roof[1]]]){
          ctx.beginPath();face.forEach((v,i)=>{const p=project(...v);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);});ctx.closePath();
          ctx.fillStyle='rgba(17,40,63,.30)';ctx.fill();
        }
        ctx.strokeStyle = `rgba(159,201,235,${.53*blend})`;ctx.lineWidth = .7;ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = project(...roof[i]), b = project(...roof[(i+1)%4]), c = project(...corners[i]);
          ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.moveTo(a.x,a.y);ctx.lineTo(c.x,c.y);
        }
        ctx.stroke();
        if(building===14){const tip=project(x,y+h+.20,z),base=project(x,y+h,z);ctx.strokeStyle='#e5d4b2';ctx.beginPath();ctx.moveTo(base.x,base.y);ctx.lineTo(tip.x,tip.y);ctx.stroke();}
      }
      for(const [lineWidth,alpha] of [[15,.05],[6,.12],[1.7,.95]]){
        ctx.beginPath();for(let j=0;j<=120;j++){const a=j/120,p=project((a-.5)*2.45,-.35,.32*Math.sin(a*TAU)+.19);j?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y);}
        ctx.lineWidth=lineWidth;ctx.strokeStyle=`rgba(255,213,145,${alpha})`;ctx.stroke();
      }
    }
    if (!illustrated && scene === 'city' && blend > .85) {
      for (const a of [0,1]) {
        const p = project((a-.5)*2.45,-.34,.19);
        if(glow){ctx.globalAlpha=.9;ctx.drawImage(glow,p.x-23,p.y-32,46,46);ctx.globalAlpha=1;}
        ctx.strokeStyle = 'rgba(255,228,180,.98)';ctx.lineWidth = 1.8;ctx.beginPath();ctx.arc(p.x,p.y-11,6,0,TAU);ctx.moveTo(p.x-4,p.y-6);ctx.lineTo(p.x,p.y+3);ctx.lineTo(p.x+4,p.y-6);ctx.stroke();
      }
    }
    const cost = performance.now() - began;
    if (meter.record(now,cost,interval)) resize();
    meter.stats.particles = illustrated?liveParticles:gpu?COUNT:Math.ceil(COUNT / (2**meter.tier));meter.stats.renderer=illustrated?'Animated reference surface + live particles':gpu?'WebGL additive surface':'Canvas 2D';meter.stats.morph = Number(blend.toFixed(3));
    if (hud) hud.textContent = `${meter.stats.fps.toFixed(1)} FPS · ${meter.stats.avgFrameMs.toFixed(1)} ms\n${meter.stats.particles} particles`;
  }
  function visibility() {
    cancelAnimationFrame(raf);raf = 0;last = 0;renderedAt = 0;meter.reset();
    if (document.hidden) {meter.stats.fps = 0;meter.stats.avgFrameMs = 0;}
    else if (!disposed) raf = requestAnimationFrame(draw);
  }
  stage.dataset.scene = scene;
  document.addEventListener('visibilitychange',visibility);resize();describe();visibility();
  return { setVoice, setScene, destroy() {
    disposed = true;gpu?.destroy();foreground?.remove();cancelAnimationFrame(raf);observer.disconnect();hud?.remove();document.removeEventListener('visibilitychange',visibility);
  } };
}
