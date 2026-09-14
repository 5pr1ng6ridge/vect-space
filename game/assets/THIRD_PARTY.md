# Demo asset notices

`assets/` 下素材仅为本地开发和回归测试提供。在项目所有者确认授权之前，
不得将它们列入公开发行中；但以下四个由
`scripts/generate-ambience-assets.mjs` 生成的 `assets/audio/ambience/` 文件除外：

- `ambience_birds.wav`
- `ambience_rain.wav`
- `ambience_intro.wav`
- `ambience_demo.wav`

`ambience.*` 是四通道环境声演示的逻辑素材 ID；它们指向由
`scripts/generate-ambience-assets.mjs` 生成的确定性单声道 PCM WAV。生成器只使用
仓库/运行时自带的 Node.js 与数学函数，不读取或混入外部录音；每个文件为 22,050 Hz、
16-bit、1 秒，并在整文件及演示循环边界保持确定性相位连续。它们属于项目生成的
开发/回归测试夹具，来源与许可证为本项目代码，不含任何第三方素材；这四个文件
已获准作为 VECTSPACE 源代码、二进制文件和安装程序的一部分再分发。

目录中的其它历史 `.ogg` 素材仍仅供本地开发和回归测试使用；本说明不代表那些
无关旧录音已取得公开发行许可。