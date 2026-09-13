# SceneSurface 迁移基线：独立表现夹具与真实 WebGL 对比入口

> 状态：统一 `SceneSurface` / 表现生命周期迁移的**基线冻结（第 1 步）与收敛记录（第 2–5 步）**。
> §1、§4–§6、§8–§9 记录的是**迁移前的真实现状快照**（历史，不改写）；§6 的实测数值与
> §7 的差异清单同样保持迁移前原样（历史记录，不是期望行为）；§7 的每条差异在 §7.1 给出
> 本次迁移的收敛结果与证据；§11 是收敛后重新跑入口的实测结果。
> 例外：§2（运行方式）与 §3（独立夹具）已在加入真实视频门禁时**刷新**，描述的是当前入口与
> 夹具（`--targets=` 覆盖、视频目标与浏览器内视频断言），不是冻结的迁移前快照。
>
> 相关实现：`game/scenes/surface_parity.yaml`、`parity/`、`scripts/check-scene-parity.mjs`、
> `crates/vectspace-protocol/src/bin/export_parity_fixture.rs`、以及共享实现
> `packages/presentation-core/src/{sceneFrame,sceneSurface,sceneTextures,timelineSession,deferredSession}.ts`。

## 1. 目的与范围

- 冻结一套**独立于现有 showcase 场景**的表现夹具，供游戏端 `PresentationController` 与
  编辑器端 `SceneSurface` 使用同一份真实运行时数据渲染。
- 提供一个**真实 WebGL**（headless Chromium + SwiftShader）的浏览器入口，产出可对比的
  截图与结构化指标，供第 2–4 步做像素/几何/时间轴的回归对比。
- 本步**不改动任何产品代码路径**：不新增运行时代码、不改共享包、不改游戏/编辑器组件；
  只新增内容夹具、测试入口、夹具导出工具、本文档，并在 `game_content.rs` 追加内容断言。

## 2. 如何运行

```bash
npm run parity:check          # 生成夹具 → 起 Vite → 驱动本机 Chromium → 写产物
npm run parity:check -- --out=<dir> --browser=<chrome/edge 可执行文件路径>
npm run parity:check -- --targets=<targets.json> --out=<dir>   # 用 OS 临时目标清单复跑负例
```

- `--targets=<path>` 覆盖默认的 `parity/targets.json`：夹具导出与检查器的目标期望
  （报告必须恰好包含清单中的目标）都以它为准，路径在启动浏览器前校验（存在、是文件、
  `schema_version: 1`、`targets` 非空且 id 唯一）。它供**只读验证者**用 OS 临时清单复跑
  反例（例如去掉 `video-timeline`：视频断言为空时入口必须以非 0 退出），无需改动仓库内文件。
- 需要的运行时：`cargo`、Node、以及**本机已安装的 Chrome 或 Edge**
  （可用 `PARITY_BROWSER` 或 `--browser=` 指定；找不到浏览器时命令以非 0 退出并给出提示）。
  本入口**不新增任何浏览器自动化依赖、不下载浏览器、不改 CI**。
- 素材必须是真实的 Git LFS 内容（未 `git lfs pull` 时导出会明确失败，不会静默跳过）。
- 产物默认写入 `.parity-output/`（已加入 `.gitignore`）：
  - `<target>--<capture>.png`：1920×1080 全尺寸截图；
  - `report.json`：缩略图 SHA-256/8×8 色彩网格、编辑器 `frameAt` 几何、WebGL 信息、诊断与错误；
  - `fixtures.json`：本次使用的完整运行时载荷（与编辑器 `build_node_preview` 的 wire 形状一致）。
- **退出码语义**：0 表示"入口跑通、无 harness 错误"；**不表示游戏与编辑器像素一致**。
  页面异常、步骤错误、缺浏览器以及真实视频夹具缺失/断言失败都会以非 0 退出；
  视频断言不得在无视频目标时静默跳过（见 §11.3）。

## 3. 独立夹具

| 位置                                          | 内容                                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game/scenes/surface_parity.yaml`             | 专用场景：背景 cross_fade → 角色立绘入场 → 镜头补间 → 时间轴（立绘位移 + 镜头 x/y/zoom）＋闪白/震动事件 → 时间轴（差分帧素材 `sprite.stopmotion`）→ 时间轴（真实视频轨 `video.test`，见 §11.3）→ 收尾 |
| `game/manifest.yaml`                          | 注册 `scenes/surface_parity.yaml`（不接入 `chapter-map`，玩家不可达）                                                                                                                                 |
| `parity/targets.json`                         | 冻结的对比目标：`stage-timeline`（`surface_parity/stage_timeline`）、`frames-timeline`（`surface_parity/frames_timeline`）与 `video-timeline`（`surface_parity/video_timeline`，真实视频夹具）        |
| `crates/vectspace-core/tests/game_content.rs` | 追加断言：夹具已注册、各目标节点的 Timeline 形状（时长/await/skippable/轨道/事件）不变（视频目标另见 §11.3）、`sprite.stopmotion` 仍是动画、夹具不得成为章节热点                                      |

夹具刻意**只使用既有节点类型与既有素材**，因此不引入新代码路径；它不替代
`presentation_showcase` / `character_action_showcase` 等手工场景，只服务于双端对比。

## 4. 数据来源（真实运行时）

`cargo run -p vectspace-protocol --bin export_parity_fixture -- game parity/targets.json <out.json>`
按 `parity/targets.json` 逐个目标：

1. `ContentCatalog::from_root(game)` 读取真实内容；
2. `RuntimeEngine::with_preview_overrides` + `preview_to_from_scene_entry` 回放到目标节点入口；
3. `preview_execute_current_node` 产出**与游戏完全相同的那次 `RuntimeUpdate`**；
4. 用 `WireRuntimeSnapshot` / `WireRuntimeUpdate` 序列化成编辑器 IPC 的 wire 形状；
5. 附带全部素材的解析结果（`assets[].path` 相对 `game/assets`，动画附带帧列表）。

每次运行都重新导出，因此夹具不会与内容/运行时漂移；入口页面把路径映射成
Vite 静态 URL 后同时喂给两个 surface。

## 5. 观测点

| 观测点   | 游戏端                                                              | 编辑器端                                          |
| -------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| 进入状态 | `applySnapshotImmediately(start)` → `game-start`                    | `load(start, update)` + `seek(0)` → `editor-0000` |
| 中段     | `present(update)` 后的**墙钟采样** → `game-mid`（约半个时间轴时长） | `seek(duration/2, true)` → `editor-mid`           |
| 结束     | `present()` settle 后 → `game-settled`（记录 outcome）              | `seek(duration, true)` → `editor-end`             |

每个观测点同时记录：`captureThumbnail()`（320×180）的字节数、SHA-256 与 8×8 平均色彩网格；
编辑器侧额外记录 `frameAt()` 的相机与每个对象的几何。全尺寸截图由 CDP 按 canvas 实际布局裁剪。

## 6. 本次实测基线

环境：Windows + Chrome `152.0.7977.83`（headless=new，SwiftShader 软渲染，DPR 1），
`WebGL 2.0 (OpenGL ES 3.0 Chromium)`。命令：`npm run parity:check` → 2 个目标、12 张截图、
0 个步骤错误、0 条页面异常。

`report.json` 中的缩略图 SHA-256（前 12 位）与编辑器几何：

| 目标            | 观测点       | 缩略图 SHA-256 | 备注                                                     |
| --------------- | ------------ | -------------- | -------------------------------------------------------- |
| stage-timeline  | game-start   | `8fa29da97602` | 与 `editor-0000` **完全相同**                            |
| stage-timeline  | editor-0000  | `8fa29da97602` | t=0 时立绘 `x=620, y=1040`，相机 `(-20, 0, 1.06)`        |
| stage-timeline  | game-mid     | `6bb72fde9f3f` | 墙钟采样，**仅示例**（连续两次运行不同）                 |
| stage-timeline  | editor-mid   | `acd8fedf3e99` | `seek(320)`：立绘 `x=720, y=1025`，相机 `(-10, 0, 1.03)` |
| stage-timeline  | game-settled | `ba724a7f7185` | 与 `editor-end` **完全相同**（outcome `completed`）      |
| stage-timeline  | editor-end   | `ba724a7f7185` | t=640：立绘 `x=820, y=1010`，相机 `(0, 0, 1.0)`          |
| frames-timeline | game-start   | `ba724a7f7185` | 与上一目标结束态相同（同一快照）                         |
| frames-timeline | editor-0000  | `321e101d3be0` | 差分帧对象在 `x=900`（时间轴 t=0 帧）                    |
| frames-timeline | game-mid     | `9a20191d8833` | 墙钟采样，**仅示例**（连续两次运行不同）                 |
| frames-timeline | editor-mid   | `eefd6b74ac59` | `x=960`，帧索引由播放头决定                              |
| frames-timeline | game-settled | `f06bf0629b9a` | 墙钟帧循环继续推进                                       |
| frames-timeline | editor-end   | `6fd26b976d34` | `x=1020`；与游戏 settle 态**不同**（帧相位差异）         |

结论性观察（仅记录，不断言）：

- `stage-timeline` 的**进入态与结束态**在两端逐像素一致（缩略图 SHA 相同），说明共享
  `evaluateTimelineFrame` 的关键帧求值与相机应用在静态点上已经对齐。
- `frames-timeline` 的结束态两端不同：游戏差分帧由 ticker 墙钟驱动，编辑器由播放头索引，
  与 §7 第 5 条一致。
- 连续两次运行中，`game-start` / `game-settled` / 编辑器三个观测点的 SHA **完全复现**；
  只有两个 `game-mid` 每次不同（墙钟采样点）。
- 中段观测点**不可直接对比**（见 §8 第 3 条）：`game-mid` 只是 `present()` 之后的墙钟采样，
  不是时间轴 seek；它只能证明"闪白在两端都会出现"，不能据此判定缓动曲线差异。

## 7. 已确认的双端差异（现状记录，待裁定；不是期望行为）

| #   | 差异                                                                                                      | 现状证据（本轮抽查确认）                                                  | 待裁定                     |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------- |
| 1   | 立绘入场补间：游戏在 `show` 时额外加 `y+48`、`scale*0.96`，编辑器预览使用原始姿态                         | `src/engine/presentation.ts:534-537`；编辑器无 cue 执行器                 | 统一方向（产品决策）       |
| 2   | 编辑器预览只执行 timeline cue，忽略背景/立绘/镜头/特写等 cue                                              | `packages/presentation-core/src/timelinePreview.ts:189-204`               | 编辑器是否开始执行全部 cue |
| 3   | 闪白衰减：游戏按 `ease_out` 采样，编辑器按事件线性推进                                                    | `src/engine/presentation.ts:694-707` vs `timelinePreview.ts:1155-1180`    | 统一到游戏的 ease-out      |
| 4   | 震动实现：游戏直接写 `world.position`，其他 `#applyCamera()` 会覆盖；编辑器把 shake 组合进 `#applyCamera` | `presentation.ts:710-723` vs `timelinePreview.ts:1113-1144`               | 统一为组合式               |
| 5   | 差分帧：游戏用 `ticker.deltaMS` 墙钟循环；编辑器帧索引 = `frameIndexAt(playhead)`，无实例相位             | `presentation.ts:116,136-160` vs `timelinePreview.ts:905-930`             | 相位/传送规则              |
| 6   | 视频漂移阈值：游戏 80ms，编辑器 40ms                                                                      | `presentation.ts:977` vs `timelinePreview.ts:1031`                        | 统一阈值（计划要求 ≤50ms） |
| 7   | 静态纹理生命周期：游戏每实例缓存 + 预算上限 + `destroy` 释放；编辑器模块级 `loadTexture` 无缓存无释放     | `presentation.ts:45-47,60,72,1299-1311` vs `timelinePreview.ts:1286-1312` | 共享引用计数缓存           |
| 8   | 绘制调度：Pixi `Application` 自动 ticker 渲染与两端手动 `render()` 并存                                   | `presentation.ts:106,116,1120`、`timelinePreview.ts:171`                  | 每帧最多一次常规 render    |
| 9   | 音频所有权：两端 Surface 构造函数各自创建 `AudioManager`                                                  | `presentation.ts:90`、`timelinePreview.ts:155-158`                        | 会话创建一次               |
| 10  | 事件消费/跳过语义差异（`at_ms > previousElapsed` + 本地 Set vs ledger `>= lastElapsed`）                  | `presentation.ts:950-957` vs `timelinePreview.ts:381-405`                 | 统一消费规则               |
| 11  | 编辑器无法加载非 timeline 载荷（`load()` 直接抛错），因此本步两个对比目标都只能是 timeline 节点           | `timelinePreview.ts:186-204`                                              | 与差异 2 同步裁定          |

## 7.1 本次迁移的收敛结果（第 2–5 步）

迁移后的结构：`SceneSurface`（唯一的 Pixi Application / 对象 / 纹理引用计数 / Cue 执行器 /
截图 / 渲染调度器）与 `TimelineSession`（唯一的时钟 / 事件账本 / 视频同步 / 音频会话）位于共享包内，
游戏端 `PresentationController` 与编辑器时间线工作区各自持有一个 per-canvas 实例；旧的
`timelinePreview.ts` 实现、`TimelinePreviewSurface` 别名与 `./timeline-preview` 出口已删除。

| §7 差异                           | 收敛结果                                                                                                                                                                                                                                                                                                          | 证据                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1 立绘入场偏移                    | 统一到游戏既有语义（入场 `y+48`、`scale*0.96`），成为共享 Cue 执行器的唯一行为；编辑器不再有第二份入场逻辑                                                                                                                                                                                                        | `sceneSurface.ts` `entryTweenPose` + `sceneSurface.test.ts`「starts a show tween from the entry offset」                          |
| 2 编辑器只执行 timeline cue       | 保持：编辑器仍只加载 timeline 载荷（写入路径不变），但执行器已是共享实现；游戏端仍按 cue 全量执行                                                                                                                                                                                                                 | `timelineSession.ts` `load({ world: "restore" \| "continue" })`；`timelineSession.test.ts` 两个入口用例                           |
| 3 闪白衰减曲线                    | 统一为游戏的 `ease_out` 采样（峰值 0.88），并按播放头求值                                                                                                                                                                                                                                                         | `sceneFrame.ts` `flashAlpha` + `sceneFrame.test.ts`                                                                               |
| 4 震动覆盖镜头                    | 统一为组合式：基础相机与震动在 `#applyCamera()` 中合成一次，闪白与震动可同时生效                                                                                                                                                                                                                                  | `sceneFrame.ts` `composeWorldTransform` + `sceneFrame.test.ts`、`sceneSurface.test.ts`「combines the base camera and shake once」 |
| 5 差分帧相位                      | 共享解码纹理 + 每实例相位：暂停冻结、拖动播放头按播放头定位（确定性）、同素材保留相位、换素材/新上下文回到第一帧；播放期间装饰循环仍按墙钟推进（不受倍速影响）                                                                                                                                                    | `imageAnimation.ts` `FrameLoopRegistry` + `imageAnimation.test.ts`、`sceneSurface.test.ts`、`timelineSession.ts` `seek()`         |
| 6 视频漂移阈值                    | 统一为 50 ms（连续播放仅在超过阈值时纠正）                                                                                                                                                                                                                                                                        | `timelineSession.ts` `VIDEO_DRIFT_THRESHOLD_MS` + `timelineSession.test.ts`                                                       |
| 7 静态纹理生命周期                | 共享引用计数纹理缓存（`SceneTextureStore`）：一次解码、多视图共享、最后一个引用释放时销毁；准备阶段失败/被取代的请求会释放自己取得的引用                                                                                                                                                                          | `sceneTextures.ts` + `sceneTextures.test.ts`、`sceneSurface.test.ts`「shares one decoded texture …」                              |
| 8 绘制调度                        | Pixi 自动 ticker 关闭（`autoStart: false`），唯一调度器把同一浏览器帧内的所有变更合成一次 render，Cue 动画共用该帧源                                                                                                                                                                                              | `sceneSurface.ts` `SceneRenderLoop` + `sceneSurface.test.ts`「renders at most once per browser frame」                            |
| 9 音频所有权                      | Surface 不创建 `AudioManager`；每个表现会话注入一份音频会话（游戏用宿主设置，编辑器用静音 + `deferUntilUnmuted` 预览策略），`dispose()` 释放一次                                                                                                                                                                  | `timelineSession.ts` `audioPolicy` + `timelineSession.test.ts`                                                                    |
| 10 事件消费语义                   | 统一为一个事件账本：窗口在起始位置闭区间（零点事件首次播放触发一次）、同刻按数组顺序、后退 seek 重新武装目标及之后的事件、跳过/静音不发声；普通编辑保留未改动的已消费事件（keyframe/时长编辑不会让恰在游标上的事件重新触发），被移动、删除、改型的事件以及时长回拉（backwards-clamped）后的目标及之后事件重新武装 | `timelineSession.ts` `#fireCrossedEvents` / `applyTimelineEdit` + `timelineSession.test.ts`、`TimelineWorkspace.test.tsx`         |
| 11 编辑器无法加载非 timeline 载荷 | 保持（编辑器入口只接受含 timeline Cue 的 update）                                                                                                                                                                                                                                                                 | `timelineSession.ts` `load()` 的错误信息 + `timelineSession.test.ts`                                                              |

§7 表中未列出、但迁移中一并收敛的项：镜头/抖动不再互相覆盖（第 4 条）、`preserveDrawingBuffer=false`
下的缩略图仍走 `renderer.extract`（游戏存档前缀校验不变）、Strict Mode 生命周期收敛为共享
`DeferredSession`（游戏与编辑器同一份实现，30 次挂载切换只创建一个 WebGL 会话）。

## 8. 明确不做的事（避免把 bug 冻结成期望）

1. **入口不断言双端相等**。`report.json` 里的 SHA/网格只是"当前现状快照"，用于第 2–5 步
   对比与排查；它们**不是**必须保持的期望值，也不作为验收门槛。
2. **不保存 golden 截图**。已确认差异列在 §7，等第 2–5 步逐条裁定后再升级为断言。
3. **中段观测点不作为行为判据**。游戏端在统一 `TimelineSession`（第 3 步）之前没有确定性
   seek，`game-mid` 只是墙钟采样；判定缓动/事件差异应等第 3 步提供 seek 之后。
4. 入口不清理也不检查 `.parity-output/` 的既有内容语义（每次运行整体重建目录）。

## 9. 已知局限与环境要求

- 需要本机 Chromium（Chrome/Edge）；没有浏览器时入口以非 0 退出（不静默跳过）。
- 依赖真实 LFS 素材与 `game/` 内容；`chapter-map` 不引用本夹具，玩家不可达。
- SwiftShader 软渲染 + 墙钟帧循环意味着**逐像素级别**的跨机器复现不保证；对比时优先看
  几何/时间等结构化指标，其次看同机同次运行的截图。
- 截图裁剪依赖 canvas 的 CSS 布局；改动 `parity/index.html` 的布局后需要重跑入口核对。
- 夹具导出使用 `WireRuntimeSnapshot`（revision/update_id 为字符串）；surface 只消费
  `world/cues` 等字段，变量仍保持 wire 标量表示。
- `parity/harness.ts` 不在根 `tsconfig.json` 的 `include` 里：把 `parity/` 纳入根程序会暴露
  `packages/presentation-core/src/timelinePreview.ts:1064` 在 `exactOptionalPropertyTypes: true`
  下的既有类型错误（编辑器 tsconfig 未开启该选项，而游戏端 `src` 此前不会把该文件拉进程序）。
  本步保持系统现状未动产品代码；第 2/3 步改到该文件时应顺手收敛这个类型错误。当前 harness
  已用等价的检查单独验证过（无 harness 自身错误），并由 `npm run parity:check` 在真实浏览器里执行。

## 11. 收敛后的实测（第 2–5 步结束）

同一环境、同一命令（`npm run parity:check`）：2 个目标 / 18 张截图 / 0 个步骤错误 / 0 条页面异常，
`report.json` 无诊断（`diagnostics` 与 `errors` 均为空）。连续两次运行的确定性观测点完全复现
（加入 §11.3 的真实视频夹具后入口报告 3 个目标 / 32 张截图）：

| 目标            | 观测点       | 缩略图 SHA-256（前 12 位） | 备注                                                                |
| --------------- | ------------ | -------------------------- | ------------------------------------------------------------------- |
| stage-timeline  | game-start   | `ec84cd983875`             | 与 `editor-0000` 逐字节相同                                         |
| stage-timeline  | editor-0000  | `ec84cd983875`             | 立绘 `x=620, y=1040`，相机 `(-20, 0, 1.06)`（与 §6 一致）           |
| stage-timeline  | game-mid     | 每次不同                   | 墙钟采样，仅示例                                                    |
| stage-timeline  | editor-mid   | `1da47574679c`             | `seek(320,"playback")`：立绘 `x=720, y=1025`，相机 `(-10, 0, 1.03)` |
| stage-timeline  | game-settled | `ac6619f88e9b`             | 与 `editor-end` 逐字节相同（outcome `completed`）                   |
| stage-timeline  | editor-end   | `ac6619f88e9b`             | t=640：立绘 `x=820, y=1010`，相机 `(0, 0, 1.0)`                     |
| frames-timeline | game-start   | `ac6619f88e9b`             | 与上一目标结束态相同                                                |
| frames-timeline | editor-0000  | `95ff202d66f9`             | 差分帧对象 `x=900`                                                  |
| frames-timeline | game-mid     | 每次不同                   | 墙钟采样，仅示例                                                    |
| frames-timeline | editor-mid   | `b8585382c9ff`             | `x=960`（播放头决定帧索引）                                         |
| frames-timeline | game-settled | `c1a1238a9ca4`             | 与 `editor-end` 逐字节相同                                          |
| frames-timeline | editor-end   | `c1a1238a9ca4`             | `x=1020`                                                            |

与 §6 的迁移前基线相比：编辑器端从「差分帧结束态与游戏不同」变为与游戏结束态一致，且编辑器三个
观测点在多次运行间完全复现；游戏端只有墙钟中段采样保持不稳定（预期）。
注意 §9 的像素级跨机器复现限制依然成立：本文件的 SHA 只用于同机同次运行的对比，
几何/相机数值与 §6 一致才是跨环境可比的部分。

### 11.1 浏览器内的取消/重置生命周期观测点

入口额外驱动一次真实浏览器内的生命周期（`game-cancel` 在 `present()` 中途
`cancelCurrentPresentation()`；`editor-cancelled-reload` / `editor-reset-reload` 在 `session.cancel()` /
`surface.reset()` 后重新 `load` 并 `seek(0)`）：

| 目标            | 观测点                  | 缩略图 SHA-256（前 12 位） | 备注                                               |
| --------------- | ----------------------- | -------------------------- | -------------------------------------------------- |
| stage-timeline  | game-cancelled          | `b1ecd147ea88`             | 取消后 stage 回到空场景；`cancelledOutcome=failed` |
| stage-timeline  | editor-cancelled-reload | `ec84cd983875`             | 与 `editor-0000` 逐字节相同                        |
| stage-timeline  | editor-reset-reload     | `ec84cd983875`             | 与 `editor-0000` 逐字节相同                        |
| frames-timeline | game-cancelled          | `b1ecd147ea88`             | 同上（同一空场景）                                 |
| frames-timeline | editor-cancelled-reload | `95ff202d66f9`             | 与 `editor-0000` 逐字节相同                        |
| frames-timeline | editor-reset-reload     | `95ff202d66f9`             | 与 `editor-0000` 逐字节相同                        |

driver 在浏览器内断言：取消结果必须是 `failed`，取消/重置后的重载必须与 `editor-0000` 逐字节一致，
且若目标含视频则取消后的 `cancelledMedia` 必须为 `null`。`report.json` 的每个编辑器观测点还记录媒体状态
（`media.muted/currentTime/targetTime/duration/readyState`），并对确定性 seek 断言
`|currentTime - targetTime| <= 50 ms`。本节记录的是**加入视频夹具之前**的状态：当时夹具没有视频轨，
因此 `media` 为 `null`；§11.3 已加入真实视频目标，浏览器入口自身会对 nonzero 媒体观测、
定位误差、几何、连续播放、取消/重载释放逐项断言。

### 11.2 本轮补修的迁移缺陷（均有先失败后通过的单测）

1. **背景与立绘共用同一逻辑素材时立绘被跳过**：`SceneSurface.prepare()` 只把该素材存进
   `preparation.background`，`applyWorld` 查 `preparation.resources` 失败后静默跳过立绘。
   修复：按角色分别登记（同时是立绘素材就写入 `resources`，是背景就写入 `background`），
   两个视图各自 claim/retain 引用。回归：`sceneSurface.test.ts`「renders a sprite that shares its
   logical asset with the background and refcounts both roles」与「shares an animation's decoded frames
   between the background and a sprite」（静态 1 次解码、动画 4 帧 1 次解码；释放一个角色后像素仍存活，
   `reset()` 后恰好释放一次）。
2. **世界没有背景时旧背景不消失**：迁移后 `#commitBackground(null)` 直接返回，而迁移前
   `#setBackground(null)` 会 `clearBackgrounds()`；切到无背景的快照时上一场景的背景残留。
   修复：`null` 时走 `#clearBackground()`。
3. 同种屏幕效果（两次 flash 或两次 shake）重叠时「最晚开始者胜、同刻取数组后者」的契约此前只有
   纯函数与单条 flash 用例：新增 `timelineEvaluator.test.ts` 的 shake 同刻/晚到/回退用例，以及
   `timelineSession.test.ts` 在 surface 边界（`setActiveEffects`）上复验同一契约。

### 11.3 真实视频夹具（浏览器内实际断言，非空言）

§11.1 记录的入口曾经无法断言视频：夹具没有视频轨，`media` 恒为 `null`，视频断言是空洞的。现新增：

- 内容侧：`game/scenes/surface_parity.yaml` 增加 `video_timeline` 节点（`video.test` =
  `videos/test_movie.mp4`，既有本地素材，H.264/`avc1` + AAC，时长 49.567s；`clip_end_ms: 4000`，
  时间轴 `duration_ms: 1600`；几何通道 `x=160, y=90, width=1600, height=900`）。
  它仍不接入 `chapter-map`，不新增/移动任何素材文件，不改发布内容或素材布局；
  `crates/vectspace-core/tests/game_content.rs` 锁定了该节点与视频轨形状。
- 入口侧：`parity/targets.json` 注册 `video-timeline` 目标；`parity/harness.ts` 在真实浏览器里驱动
  **两个共享宿主**（游戏 `PresentationController` 与编辑器 `EditorTimelinePreview`→`TimelineSession`）：
  - 游戏端：`game-mid` 墙钟采样（有界轮询至真实解码就绪且漂移 ≤50ms），`game-present-settled` 与
    `game-cancel` 断言媒体元素被释放；
  - 编辑器端：`editor-0000`/`editor-scrub-400/800/1200`/`editor-latest-seek`（重叠两次 scrub，最后发出者生效）
    断言真实 `HTMLVideoElement` 的 `currentTime` 非零、`readyState ≥ 2`、解码尺寸
    `videoWidth/videoHeight ≥ 2`、`|currentTime - targetTime| ≤ 50 ms` 以及视频几何；
    `editor-video-playback` 单独做连续播放检查（真实 `play()` 前进 + 漂移阈值），不与 scrub 混同；
    `editor-cancelled-reload` / `editor-reset-reload` 断言取消后 `videoState === null` 且重载后媒体回到 0。
  - 判定：`scripts/check-scene-parity.mjs` 在**没有任何视频目标**、视频观测数不足、或任一项
    `video.checks` 失败时都以非 0 退出并把失败明细打到 stderr，因此"视频缺失"不再等于“静默跳过”。

实测（`npm run parity:check`，CDP `Browser.getVersion` = `Chrome/152.0.7977.83`，
headless=new + SwiftShader，`WebGL 2.0 (OpenGL ES 3.0 Chromium)`）：3 个目标 / 32 张截图 /
0 个步骤错误 / 0 条页面异常；真实视频：**1 个目标 / 13 个观测 / 42 项断言 / 0 失败**。关键观测值：

| 观测点                      | 真实值                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `game-mid`（游戏）          | `paused=false`，`currentTime=0.344s` vs `targetTime=0.358s`（漂移 14ms），`readyState=4`，1920×1080 |
| `editor-scrub-400/800/1200` | `currentTime` 逐点等于 `0.400/0.800/1.200s`，`readyState=4`，几何 `{160,90,1600,900}`               |
| `editor-latest-seek`        | 目标 320ms 与 1280ms 重叠；最终 `currentTime=1.280s`（最后发出者生效，误差 0）                      |
| `editor-video-playback`     | `paused=false`，`currentTime` `0.420→0.480→0.542s`（播放头 0.406→0.479→0.576s）漂移 ≤33ms           |
| 取消/重载                   | `cancelReleased=true`；重载后 `currentTime=0`，`readyState=4`，`videoWidth=1920`                    |

反例已实测：临时移除 `video-timeline` 目标后入口报告 `视频：0 个目标 / 0 个真实观测 / 0 项检查`
并以退出码 1 失败（提示"没有任何目标包含视频轨：浏览器视频断言为空（夹具缺失，不得静默跳过）"）。
环境说明：入口在 headless 页面里加 `--autoplay-policy=no-user-gesture-required`，否则编辑器预览
`play()` 会等不到用户手势而无法开始真实播放；这只取消手势要求，不使用 mock 媒体/时间。
若某环境的 Chromium 不具备 H.264 解码，`video.checks` 会失败并以非 0 退出（不会伪造通过）。

## 10. 后续步骤如何使用

1. 第 2–4 步在改动后运行 `npm run parity:check`，对比 `.parity-output/report.json` 的：
   - 双端进入/结束态缩略图 SHA 与网格（静态对齐）；
   - 编辑器 `frameAt` 几何与游戏端截图（几何对齐）；
   - `game.outcome`、步骤错误与页面异常（生命周期不回退）。
2. 收敛一条差异时：在本文件 §7 删除该条、把对应断言写进入口（或新增单测），并在提交信息里
   引用该条编号。
3. 若新增对比目标：改 `parity/targets.json` 并在 `game_content.rs` 同步断言。
