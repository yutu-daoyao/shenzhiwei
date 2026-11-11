import {parentPort,workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),sherpa=require('sherpa-onnx-node');
const extractor=new sherpa.SpeakerEmbeddingExtractor({model:workerData.model,numThreads:1,debug:false});
parentPort.postMessage({ready:true});
parentPort.on('message',({id,pcm})=>{
  const bytes=Buffer.from(pcm),samples=new Float32Array(bytes.length/2);
  try{for(let i=0;i<samples.length;i++)samples[i]=bytes.readInt16LE(i*2)/32768;const stream=extractor.createStream();stream.acceptWaveform({sampleRate:16000,samples});stream.inputFinished();if(!extractor.isReady(stream))throw Error('too short');const embedding=Array.from(extractor.compute(stream,false));parentPort.postMessage({id,embedding});}
  catch{parentPort.postMessage({id,error:'声纹计算失败，请重新录制清晰的完整句子。'});}
  finally{samples.fill(0);bytes.fill(0);}
});
