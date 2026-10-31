# VECTSPACE Story Editor

独立的 Tauri 2 剧情图编辑器，用于编辑 VECTSPACE `game/manifest.yaml` 和
`game/scenes/*.yaml`（以及清单登记的动画、动作、按钮、UI 动效、固定文本、粒子和
章节地图文档）。

这个东西应该没有发布的打算，只是给开发者制作作品用的。（

操作说明见 [`docs/editor-tutorial.zh-CN.md`](../docs/editor-tutorial.zh-CN.md)；
本文只记录启动方式、文件与安全行为、编辑器元数据格式和代码结构。

## 启动

在仓库根目录（`npm ci` 已经通过 npm workspace 安装了编辑器依赖）：

```powershell
npm run editor:dev
```

也可以在 `editor/` 目录运行：

```powershell
npm run tauri dev
```

如果当前终端找不到 Cargo，请先把 Rust 工具链加入 `PATH`：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
```

发布构建：

```powershell
npm run editor:build
```

NSIS 安装包位于 `target/release/bundle/nsis/`。启动与构建前都会运行素材预检
（LFS 指针检查）。

打开项目时选择仓库根目录，或直接选择包含 `manifest.yaml` 的 `game/` 目录。

## 文件与安全行为

- YAML 使用游戏本身的 Rust 数据类型、严格解析器和跨引用校验器；编辑器检查器只
  编辑 Rust 规范化后的规范形状（例如背景转场、屏幕效果的带标签对象），旧的一词
  YAML 仍可加载，保存时写回规范形状。
- 保存前先验证完整候选项目，不会将已知无效的内容写入磁盘。
- 保存检查打开项目时的 SHA-256 指纹，防止覆盖外部编辑。
- 只序列化并替换字节实际变化的文档；未修改的文档保留原字节（包括注释和手工格式）。
- 多文件保存先写入 `.vectspace/tmp/<save-id>/`；旧文件按相对路径备份到
  `.vectspace/backups/<save-id>/`，最多保留最近 10 代；保存失败时从事务备份恢复。
  这两类恢复数据均被 Git 忽略。
- 删除场景或素材登记不会删除原素材/YAML 文件，以便恢复。
- 素材导入先经过 Rust 检查（格式、尺寸/时长、大小、哈希）再进入不透明的暂存会话；
  素材与 manifest、Scene 和地图一起进入同一个可恢复事务，未保存或撤销的导入不会
  写入正式 `game/assets`。仍被引用的素材不能从 manifest 移除。

## 编辑器元数据

节点位置、画布视口、布局组、时间线/长文本预览路径和素材分组都写入
`game/.vectspace/layout-v1.json`，不污染剧情 YAML。

素材文件夹、显示名和隐藏标记是**纯编辑器元数据**：

- `asset_folders`：`folder_id -> { parent_id, name, order }` 的稳定 ID 树；
  `asset_metadata`：`asset_id -> { folder_id?, display_name?, hidden? }`。
- 两个字段都是可选的；缺少它们的布局原样加载，不会被改写。宿主会修复手写的
  非法数据（非法文件夹 ID/名称、悬空父级、环、指向已删文件夹的引用），但**不会**
  因为素材被删除而丢弃元数据或拒绝打开项目。
- 文件夹只是分组：移动、改名、隐藏都不会改变 manifest 路径、素材 ID、运行时引用或
  磁盘上的二进制文件。
- 隐藏素材仍可在素材面板中管理；**新选择**列表会排除它们，但当前已选中的隐藏 ID
  仍会显示并标记为“已隐藏”。所有选择入口共用 `AssetChooser` 与
  `assetChoiceOptions`，布局元数据通过 `AssetLayoutProvider` 覆盖整个编辑器。

## 替换素材文件

“替换二进制”保持同一逻辑 ID 和全部引用，只把该条目指向一个**新路径**；旧文件永远不
覆盖、不删除，作为未登记的回滚副本留在 `assets/` 中。

- 请求使用 `WireImportAssetRequest.replace_id`（必须等于 `id`）。宿主会拒绝未知 ID、
  类型不符、目标是合成动画素材、目标路径与原路径相同、实际格式不同，以及新图片与
  帧动画尺寸不一致的替换。替换**不会**复用已存在的同内容文件：它一定拥有新的暂存二进制。
- 暂存结果给出新路径（含 `absolute_path`）与 `replaced_from`；编辑器就地更新同一行素材
  与 manifest 条目，不新增第二行。保存前预览使用暂存路径，因此 URL/纹理缓存自动刷新。
- 宿主**永远不接受**写回原始文件或任何先前暂存的替换路径；选择器遵循同一规则，并在
  重名时给出唯一的 `_v2` / `_v3` 建议名。
- 保存事务把新二进制和 manifest/layout 一起写入同一个 journal，旧素材路径不会进入
  删除列表（素材二进制从来不由编辑器删除）。若源文件变化、token 失效、指纹过期或事务
  失败，旧登记与旧二进制都保持原样。
- 撤销会恢复旧路径与旧行；被取代的暂存 token 与暂存二进制保留以便重做，保存只提交与
  manifest 路径一致的那个 token。

## 代码结构

- `src/App.tsx`：项目状态与撤销历史；`src/app/`：命令、路由（`routes.ts`）和项目会话，
  路由决定显示剧情图还是某个全屏工作区。
- `src/shell/`：顶栏、活动栏、状态栏、欢迎页、项目搜索、工作区统一顶栏
  （`WorkspaceHeader.tsx`）。
- `src/components/`：检查器、各工作区和预览。所有关键帧工作区（剧情时间线、立绘动作、
  按钮模板、UI 动效）共用 `TimelineSurface`，各自只把本领域结构映射成中立轨道再折叠
  回去；循环帧动画仍是有序帧列表，不属于关键帧界面。
- `src/ui/`：基于 Radix 无样式原语与 lucide 图标的通用组件（按钮、菜单、对话框、通知、
  提示）以及键盘策略（`keyboard.ts`）和“提交中字段”登记（`pendingCommits.ts`）。
- `src/styles/`：以 `index.css` 为唯一入口的 CSS 层叠（层顺序见该文件）；颜色只允许在
  `tokens.css` 中定义，由 `tokens.guard.test.ts` 检查。
- `src-tauri/`：编辑器宿主（项目读写、事务保存、素材导入、预览运行时）。
- `preview.html` + `src/dev/`：仅开发用的浏览器设计预览（`npx vite` 后打开 `/preview.html`），
  用演示项目替代 Tauri 后端，便于检查界面。

时间线与长文本工作区、各类内嵌预览直接实例化共享的 `SceneSurface`、`TimelineSession`、
`LongTextPanel`、`TemplateButton` 和 `ChoiceLayer`，与游戏端是同一份实现（见根
`README.md` 的架构章节）。

## 快捷键

- `Ctrl+S`：先提交正在编辑的字段再保存（输入框内同样有效）
- `Ctrl+Z` / `Ctrl+Y`（或 `Ctrl+Shift+Z`）：撤销 / 重做；焦点在文本框里时作用于文字本身
- `Ctrl+F`：项目搜索
- `Ctrl+L`（或 `Ctrl+Shift+L`）：剧情图组合所选节点 / 布局组，或解散唯一选中的组；也可右键选择对应操作
- `Ctrl+Enter`：从选中节点预览
- `Delete`：删除选中节点 / 关键帧 / 地图对象（选中含布局组时不删除）
- `Esc`：关闭菜单 → 取消拖拽 → 输入框失焦 → 退出全屏工作区
- 完整列表见教程第 16 章。
- Windows WebView2 的浏览器级右键菜单、刷新/导航、新窗口、查看源代码、DevTools、缩放和 `F1`–`F12` 快捷键已关闭。

## 检查

```powershell
npm --prefix editor test
npm run editor:check
cargo test --workspace
```
