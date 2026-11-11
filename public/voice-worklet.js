// One continuous device stream: no per-packet Audio elements or device restarts.
class ZhiweiDuplex extends AudioWorkletProcessor {
  constructor(){super();this.frames=[];this.offset=0;this.capture=new Int16Array(320);this.used=0;this.capturing=true;this.captureEpoch=0;this.buffered=0;this.playing=false;this.meterSamples=0;this.inputPower=0;this.outputPower=0;
    this.port.onmessage=({data})=>{if(data.type==='capture'){this.capturing=data.enabled;this.captureEpoch=data.epoch;this.used=0;}else if(data.type==='reset'){this.frames=[];this.offset=0;this.buffered=0;this.playing=false;}else if(data.type==='flush'){this.playing=true;}else if(data.type==='audio'&&data.samples instanceof Float32Array){if(this.buffered+data.samples.length>16000){this.port.postMessage({type:'error'});return;}this.frames.push(data);this.buffered+=data.samples.length;}};
  }
  process(inputs,outputs){
    const input=inputs[0]?.[0],output=outputs[0]?.[0];
    if(input&&this.capturing)for(const sample of input){this.capture[this.used++]=Math.round(Math.max(-1,Math.min(1,sample))*32767);if(this.used===320){this.port.postMessage({type:'mic',pcm:this.capture.buffer,epoch:this.captureEpoch},[this.capture.buffer]);this.capture=new Int16Array(320);this.used=0;}}
    if(output){
      // A small initial jitter cushion; drain also permits a short final packet.
      if(!this.playing&&this.buffered>=800)this.playing=true;
      for(let i=0;i<output.length;i++){
        if(!this.playing||!this.frames.length){output[i]=0;continue;}
        const frame=this.frames[0];output[i]=frame.samples[this.offset++];this.buffered--;
        if(this.offset===frame.samples.length){this.frames.shift();this.offset=0;this.port.postMessage({type:'played',id:frame.id});}
      }
      if(!this.frames.length)this.playing=false;
    }
    // Measure the device output after jitter buffering, including real silence.
    const count=output?.length||input?.length||0;
    for(let i=0;i<count;i++){this.inputPower+=(input?.[i]||0)**2;this.outputPower+=(output?.[i]||0)**2;}
    this.meterSamples+=count;
    if(this.meterSamples>=640){
      this.port.postMessage({type:'level',listening:Math.sqrt(this.inputPower/this.meterSamples),speaking:Math.sqrt(this.outputPower/this.meterSamples)});
      this.meterSamples=0;this.inputPower=0;this.outputPower=0;
    }
    return true;
  }
}
registerProcessor('zhiwei-duplex',ZhiweiDuplex);
