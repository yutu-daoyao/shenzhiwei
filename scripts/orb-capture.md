# 光球截图与录屏

Windows 使用现有 Node 24 和 Chrome，无需新增 npm 依赖，也无需启动知微后端：

```powershell
node scripts/orb-capture.js --screenshots-only --out work/orb-capture
```

生成 `orb-idle.png`、`orb-listening.png`、`orb-speaking.png` 和 `fps.json`。默认输出为当前目录的 `work/orb-capture`；Windows 自动选择 Program Files 中的 Google Chrome，其他位置可设置 `$env:CHROME_BIN`（也可指向 Edge）。Linux 默认 `/usr/bin/google-chrome`。

不传 `--screenshots-only` 时还采集约 10 秒循环并用现有 ffmpeg 编码 `orb-demo.mp4`；可用 `FFMPEG_BIN` 指定 ffmpeg。没有 ffmpeg 时仍会保留截图、帧与 FPS 文件，编码报错会非零退出。

静态服务器仅开放 public/，模拟页面不连接 EventSource，不申请麦克风，不调用 Codex/百炼。浏览器使用临时配置，退出后验证目录范围再清理；Windows 子进程隐藏窗口，保留 Chromium 自身沙箱。

截图采用 1280×720、DPR 1、ANGLE SwiftShader 软件渲染；各态等待 3 秒。`fps` 是实际绘制频率，`avgFrameMs` 是实际帧间隔，`captureFps` 只是录屏采集频率。软件渲染和截图会显著影响性能，不能据此断言笔记本硬件帧率。运行中可添加 `?orbFps=1` 查看统计。

重跑会覆盖同名产物，完整录屏会清理 frames/ 中匹配 frame-数字.jpg 的文件。失败写 capture-error.json，成功后移除此错误记录。受限环境若阻止 Chrome 或本机端口，请在普通宿主终端运行同一命令。
