// Reference materials remain textures; their surface and light move independently.
const TAU = Math.PI * 2;
export function artworkPoint(scene,x,y,time,energy=0) {
  if(scene==='mobius') return {x:x+Math.sin(time*.7+y*6)*.009*Math.sin(x*Math.PI),y:y+Math.sin(time*.85+x*7)*(.030+energy*.012)*Math.sin(x*Math.PI)};
  return {x,y};
}

export function createArtworkSurface(gl,compile) {
  const program=gl.createProgram();
  gl.attachShader(program,compile(gl.VERTEX_SHADER,`
    attribute vec2 aUV;uniform vec4 uFit;uniform float uTime,uEnergy,uScene;varying vec2 vUV;
    void main(){
      vec2 p=aUV;
      if(uScene<.5){p.x+=sin(uTime*.7+p.y*6.)*.009*sin(aUV.x*3.141593);p.y+=sin(uTime*.85+aUV.x*7.)*(.030+uEnergy*.012)*sin(aUV.x*3.141593);}
      gl_Position=vec4((p.x-.5)*uFit.x+uFit.z,(.5-p.y)*uFit.y+uFit.w,0.,1.);vUV=aUV;
    }`));
  gl.attachShader(program,compile(gl.FRAGMENT_SHADER,`
    precision mediump float;uniform sampler2D uImage;uniform float uOpacity,uTime,uEnergy;varying vec2 vUV;
    void main(){
      vec4 c=texture2D(uImage,vUV);
      float wave=.5+.5*sin(vUV.x*17.-vUV.y*9.-uTime*1.8);
      c.rgb*=.92+wave*.16+uEnergy*.12;c.a*=uOpacity;
      gl_FragColor=vec4(c.rgb*c.a,c.a);
    }`));
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Artwork shader link failed');
  const data=[];
  for(let x=0;x<72;x++)for(let y=0;y<36;y++)data.push(x/72,y/36,(x+1)/72,y/36,(x+1)/72,(y+1)/36,x/72,y/36,(x+1)/72,(y+1)/36,x/72,(y+1)/36);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'aUV'),textures=new Map();
  const uniforms=Object.fromEntries(['uFit','uTime','uEnergy','uScene','uImage','uOpacity'].map(n=>[n,gl.getUniformLocation(program,n)]));
  return {
    draw(asset,scene,{width,height,w,h,time,energy,opacity}){
      let texture=textures.get(asset);
      if(!texture){
        texture=gl.createTexture();textures.set(asset,texture);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,asset);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,gl.canvas.width,gl.canvas.height);
      gl.useProgram(program);for(let i=0;i<5;i++)gl.disableVertexAttribArray(i);
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform1i(uniforms.uImage,0);
      gl.uniform4f(uniforms.uFit,w*2/width,h*2/height,0,.02);
      for(const [key,value] of Object.entries({uTime:time,uEnergy:energy,uScene:scene==='city'?1:0,uOpacity:opacity}))gl.uniform1f(uniforms[key],value);
      gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.drawArrays(gl.TRIANGLES,0,data.length/2);
      gl.disableVertexAttribArray(position);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    },
    destroy(){textures.forEach(t=>gl.deleteTexture(t));gl.deleteBuffer(buffer);gl.deleteProgram(program);}
  };
}

// Control points measured in the reference image, so moving lights stay on its road.
const road=[[.315,.737],[.38,.719],[.415,.665],[.47,.615],[.56,.589],[.593,.542],[.592,.475],[.635,.444],[.699,.414]];
export function artworkFlow(scene,u,lane=0) {
  if(scene==='city'){
    const a=Math.min(road.length-1.000001,u*(road.length-1)),i=Math.floor(a),t=a-i;
    const p=road[Math.max(0,i-1)],q=road[i],r=road[i+1],s=road[Math.min(road.length-1,i+2)];
    const at=k=>.5*((2*q[k])+(-p[k]+r[k])*t+(2*p[k]-5*q[k]+4*r[k]-s[k])*t*t+(-p[k]+3*q[k]-3*r[k]+s[k])*t*t*t);
    return {x:at(0),y:at(1)};
  }
  const angle=u*TAU;
  return {x:.50+Math.sin(angle)*(.433+lane*.028),y:.51+Math.sin(angle*2)*(.26+lane*.045)-Math.sin(angle)*.13+lane*.07*Math.cos(angle*.5)};
}

export function paintArtworkLights(ctx,scene,{w,h,time,energy=0,opacity=1,reduced=false,tier=0,glow}) {
  const count=reduced?0:Math.ceil((scene==='city'?60:1050)/2**tier);
  ctx.save();ctx.globalCompositeOperation='lighter';
  for(let i=0;i<count;i++){
    const seed=((i*7919)%104729)/104729,lane=((i*3571)%8191)/4095.5-1;
    const u=(seed+time*(scene==='city'?.055:.034)*(1+energy*.35))%1;
    const p=artworkFlow(scene,u,lane),q=artworkPoint(scene,p.x,p.y,time,energy);
    const sparkle=.55+.45*Math.sin(time*2.2+i*2.4),head=i%47===0;
    const x=(q.x-.5)*w,y=(q.y-.5)*h;
    ctx.globalAlpha=opacity*(head?.85:.2+sparkle*.48);
    ctx.fillStyle=lane>0?'#ffe3ad':'#b9ddff';
    ctx.beginPath();ctx.arc(x,y,head?1.5:.35+seed*.7,0,TAU);ctx.fill();
    if(head){
      if(glow)ctx.drawImage(glow,x-9,y-9,18,18);
      ctx.strokeStyle=ctx.fillStyle;ctx.lineWidth=.7;ctx.beginPath();
      for(let j=0;j<12;j++){
        const v=(u-j*.00065+1)%1,a=artworkFlow(scene,v,lane),b=artworkPoint(scene,a.x,a.y,time,energy);
        j?ctx.lineTo((b.x-.5)*w,(b.y-.5)*h):ctx.moveTo((b.x-.5)*w,(b.y-.5)*h);
      }
      ctx.stroke();
    }
  }
  if(scene==='city')for(const [i,[x,y]] of [[0,road[0]],[1,road.at(-1)]]){
    const phase=reduced?.3:(time*.55+i*.5)%1;
    ctx.globalAlpha=opacity*(1-phase)*.75;ctx.strokeStyle='#ffe1a6';ctx.lineWidth=1.2;
    ctx.beginPath();ctx.ellipse((x-.5)*w,(y-.5)*h,8+phase*w*.035,3+phase*h*.018,0,0,TAU);ctx.stroke();
  }
  ctx.restore();return count;
}
