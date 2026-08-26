# VECTSPACE Story Editor

独立的 Tauri 2 剧情图编辑器，用于编辑 VECTSPACE `game/manifest.yaml` 和
`game/scenes/*.yaml`。

## 启动

在仓库根目录运行：

```powershell
npm --prefix editor install
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

NSIS 安装包位于：

```text
editor/src-tauri/target/release/bundle/nsis/
```

## 使用方式

1. 选择仓库根目录或包含 `manifest.yaml` 的 `game/` 目录。
2. 在左侧切换场景、素材或项目设置。
3. 从节点右侧端口拖线到目标节点。连线会直接修改 YAML 的跳转字段。
4. 在右侧检查器编辑所选节点。所有 14 种运行时节点均有类型化表单，
   `condition` 与条件选项使用可递归的条件构建器。
5. 在“项目”页声明 `save` / `profile` 变量、类型和默认值。
6. 使用底部“问题”面板修复错误，再保存项目。
7. 保存后可在“剧情试玩”面板通过真实 Rust RuntimeEngine 从项目入口运行。

## 文件与安全行为

- YAML 使用游戏本身的 Rust 数据类型、严格解析器和跨引用校验器。
- 保存前先验证完整候选项目，不会将已知无效的内容写入磁盘。
- 保存检查打开项目时的 SHA-256 指纹，防止覆盖外部编辑。
- 多文件保存先写相邻临时文件；旧文件保留为 `*.vectspace.bak`。
- 节点位置和画布视口写入 `game/.vectspace/layout-v1.json`，不污染剧情 YAML。
- 删除场景或素材登记不会删除原素材/YAML 文件，以便恢复。
- 第一次由可视化编辑器保存时，YAML 会被规范化输出，原注释和手工格式不会保留；
  首次保存前请确认项目已有版本控制或使用生成的备份文件。

## 快捷键

- `Ctrl+S`：保存
- `Ctrl+Z`：撤销
- `Ctrl+Y` 或 `Ctrl+Shift+Z`：重做
- Windows WebView2 的浏览器级右键菜单、刷新/导航、新窗口、查看源代码、DevTools、缩放和 `F1`–`F12` 快捷键已关闭。

## 检查

```powershell
npm --prefix editor test
npm --prefix editor run build
cargo test --manifest-path editor/src-tauri/Cargo.toml
```
