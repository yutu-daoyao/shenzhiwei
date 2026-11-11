// Remote audio only. The microphone is never connected to this processor.
class CaptionPlayback extends AudioWorkletProcessor {
  constructor(){super();this.capacity=Math.ceil(sampleRate*120);this.left=new Float32Array(this.capacity);this.right=new Float32Array(this.capacity);this.read=0;this.write=0;this.count=0;this.open=false;this.capturing=false;this.heard=false;this.silence=0;this.failed=false;this.inputSilence=0;this.meterSamples=0;this.meterSum=0;
    this.port.onmessage=({data})=>{if(data.type==='reset'){this.read=this.write=this.count=0;this.open=false;this.capturing=false;this.heard=false;this.silence=0;}else if(data.type==='release'){this.open=true;this.heard=false;this.silence=0;}else if(data.type==='hold')this.open=false;};
  }
  process(inputs,outputs){
    const input=inputs[0]||[],output=outputs[0]||[];const frames=output[0]?.length||128;
    for(let i=0;i<frames;i++){
      const a=input[0]?.[i]||0,b=input[1]?.[i]??a;
      if(Math.abs(a)+Math.abs(b)>0.0002){this.capturing=true;this.inputSilence=0;}else if(++this.inputSilence>sampleRate)this.capturing=false;
      if(this.capturing){
        if(this.count>=this.capacity){if(!this.failed){this.failed=true;this.port.postMessage({type:'overflow'});}return false;}
        this.left[this.write]=a;this.right[this.write]=b;this.write=(this.write+1)%this.capacity;this.count++;
      }
      let x=0,y=0;
      if(this.open&&this.count){
        // Old silence is not part of the next spoken response.
        if(!this.heard)while(this.count&&Math.abs(this.left[this.read])+Math.abs(this.right[this.read])<=0.0002){this.read=(this.read+1)%this.capacity;this.count--;}
        if(this.count){x=this.left[this.read];y=this.right[this.read];this.read=(this.read+1)%this.capacity;this.count--;}
        if(Math.abs(x)+Math.abs(y)>0.0002){this.heard=true;this.silence=0;}else if(this.heard)this.silence++;
        
      }
      if(output[0])output[0][i]=x;if(output[1])output[1][i]=y;
      this.meterSum+=(x*x+y*y)/2;if(++this.meterSamples>=sampleRate/25){this.port.postMessage({type:'level',value:Math.sqrt(this.meterSum/this.meterSamples)});this.meterSum=this.meterSamples=0;}
    }
    return true;
  }
}
registerProcessor('zhiwei-caption-playback',CaptionPlayback);
