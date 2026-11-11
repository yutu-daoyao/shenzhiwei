import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Explicit npm live commands still run normally; test discovery must never spend an account's quota.
export function guardLiveScript(moduleUrl) {
  if(process.env.NODE_TEST_CONTEXT&&process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(moduleUrl)){
    console.log('跳过自动发现的真实服务实测。请通过对应的 npm 实测命令主动启动。');
    process.exit(0);
  }
}
