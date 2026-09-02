# VECTSPACE

VECTSPACE is a Windows-first visual novel runtime rebuilt with Tauri 2, Rust,
React 19, PixiJS 8, and KaTeX. It deliberately does not support the previous
engine's scripts, saves, or runtime APIs.

## Toolchain

- Node.js `24.19.0` managed by Volta
- Rust stable MSVC (`rustup default stable-msvc`)
- Git LFS for binary game assets
- Microsoft Edge WebView2 Runtime
- Windows x64 and NSIS (`currentUser`) packaging

Install the host tools in PowerShell, then restart the terminal:

```powershell
winget install --id Volta.Volta --exact
winget install --id Rustlang.Rustup --exact
winget install --id GitHub.GitLFS --exact
winget install --id Microsoft.EdgeWebView2Runtime --exact
volta install node@24.19.0
rustup default stable-msvc
git lfs install
```

Install locked JavaScript packages and run the desktop app:

```powershell
git lfs pull
npm ci
npm run tauri dev
```

Both development apps and production builds run an asset preflight before
Vite starts. If a clone contains LFS pointer text instead of real images,
fonts, audio, or video, startup stops with the affected paths and recovery
command instead of opening a partially broken preview.

Useful checks:

```powershell
npm run build
npm test
npm run lint
npm run codegen:check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm run tauri build
```

The repository is both a Cargo workspace and an npm workspace. Root
`Cargo.lock` and `package-lock.json` are the only lockfiles.

## Visual story editor

`editor/` contains a separate Tauri application for editing the YAML story as a
directed node graph. It shares the game's Rust content model, validator, and
runtime, supports all current node types, keeps layout metadata outside scene
YAML, and validates the complete project before an atomic save.

```powershell
npm --prefix editor install
npm run editor:dev
```

Build its standalone Windows installer with `npm run editor:build`. See
`editor/README.md` for authoring and backup behavior.

## Runtime architecture

The browser-facing Vite bundle contains UI code only. Game content lives at the
repository root:

```text
game/
├── manifest.yaml
├── scenes/
└── assets/
```

In development Rust reads `game/` directly. The installer maps that directory to
`$RESOURCE/game`. Rust is the only reader of manifest and scene YAML. At startup
it canonicalizes every registered asset, rejects traversal, and dynamically
allows only `game/assets` in Tauri's asset protocol. The WebView receives logical
asset IDs resolved to validated paths; it has no filesystem permission and
cannot fetch scene YAML.

`vectspace-core` owns the Tauri-independent content model, validation, runtime,
conditions, interpolation, and timeline evaluation. `vectspace-protocol` owns
IPC boundary values and generates checked-in TypeScript bindings; signed 64-bit
integers cross IPC as canonical decimal strings instead of JavaScript numbers.
The two Tauri crates are host adapters for resources, persistence, windows, and
commands.

Rust owns story logic and the stable world state. Every mutation returns:

```text
RuntimeUpdate
├── snapshot  stable, authoritative, saveable target state
└── cues      one-shot presentation instructions, never saved
```

The frontend keeps the authoritative snapshot separately from the currently
presented Pixi world. Cues animate from the latter; completion, failure, skip, or
interruption always ends with a hard reconciliation to the snapshot. Runtime
cues are acknowledged back to Rust, while `revision` guards prevent stale
double-clicks. Cue IDs are de-duplicated independently of React Strict Mode by
bounded, session-scoped ledgers.

Saves contain only snapshots. The automatic slot and manual slots `1`–`3` use a
temporary file plus backup. Loading cancels transient presentation state and
returns an update with no cues, so SFX, flashes, shakes, and transitions are not
replayed.

## Fixed viewport

All rendering uses one `1920 × 1080` design space. A single CSS transform scales
the `GameViewport`; Pixi remains at `1920 × 1080`, resolution `1`, and stage scale
`1`. Extra window area is black. `screenToDesign()` is the only conversion for
screen-space input intended for Pixi interactions.

## Scene format

`game/scenes/prologue.yaml` is a two-route demonstration of background and
sprite transitions, formula dialogue, SFX, choices, variables, branching,
camera motion, screen effects, Runtime gates, and snapshot-only saves. Supported
node types are:

```text
background  sprite  say  long_text  choice  set  condition  jump  wait
playback  bgm  sfx  camera  screen_effect  dialogue_ui  timeline  end
```

Schema v2 declares every variable in `manifest.yaml` with an explicit type,
default, and `save` or `profile` scope. Save variables live in slot snapshots;
profile variables live in `profile.json` and are never rolled back by loading a
slot. Recursive conditions support `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `and`,
`or`, and `not`, and the same expressions can hide or disable individual
choices.

Unknown fields, duplicate YAML keys, missing nodes, wrong asset kinds, invalid
variables, paths outside the content root, invalid ranges, and unsupported schema
versions are rejected before the app starts. Schemas and protocol bindings are
changed only by `npm run codegen`; normal development startup never writes
generated repository files.

Dialogue accepts `$...$`, `$$...$$`, `[pause=500ms]`, speed controls, and the
`shake`, `wave`, and `glow` text effects. It never accepts HTML. The renderer lays
out every Chinese character and KaTeX formula first, then reveals units with
`visibility`; hidden content keeps its geometry and formulas reveal atomically.
The player can choose `line_sweep`, `typewriter`, or `drop_fade` in Settings;
individual `say` and `long_text` nodes may use `reveal_animation` to override
that preference for a single prompt.

`long_text` is the full-screen alternative to `say` for mathematical exposition.
It displays accumulated `steps` in a positioned scrolling text block. Every click
reveals and confirms one step; the reader smoothly follows new writing once it
reaches the lower reading guard, while wheel or drag browsing pauses follow until
the next story step. Each step has a stable ID, so saving during a lecture restores
the already-written paper without replaying typing or scrolling. `paper` is
optional: omitting it leaves the block transparent for blackboard-style writing.
`pagination` can be `continuous`, `auto`, or `manual`; automatic mode also accepts
explicit `page_break_before` markers. `layout` uses 1920×1080 design pixels.

```yaml
lecture:
  type: long_text
  paper: gui.lecture_paper # optional
  pagination: auto
  font_size: 32
  text_color: "#212533"
  layout:
    x: 340
    y: 0
    width: 1240
    height: 1080
    padding_x: 118
    padding_y: 112
    page_height: 1340
    page_gap: 92
  reveal_animation: line_sweep # optional; otherwise player setting
  speed_cps: 28 # optional
  steps:
    - id: definition
      text: "设 $V$ 是一个向量空间。"
    - id: consequence
      page_break_before: true
      text: "因此 $0\\in V$。"
  next: next_node
```

## Current scope

The runtime includes the fixed viewport, validated Schema v2 content, Pixi
presentation and timeline cues, video tracks, KaTeX dialogue, BGM/SFX buses,
automatic playback, three Ctrl fast-forward policies, forced playback sections,
profile-level read tracking, a 500-entry dialogue history, three manual slots
plus autosave, and a read-only revealed story-flow page.

The editor includes typed scene graphs, recursive conditions, characters and
variables, a diagnostic sidebar, full-screen timeline and UI-motion workspaces,
direct Pixi object manipulation, and a manually-authored story-flow workspace.
Pixi/ELK workspaces are lazy-loaded. Saves validate an in-memory candidate and
replace only changed documents; recovery data lives under ignored
`.vectspace/backups/` and `.vectspace/tmp/` directories.

The next gameplay milestone is a generic deterministic mathematics Activity
boundary. Character voice is intentionally out of scope; 30 slots, quick saves,
multiple windows, theorem cards, Lean, and rhythm gameplay remain later work.

The copied demo assets and license notice are documented in
`game/assets/THIRD_PARTY.md`. Confirm the ownership of project sample art/audio
before a public release.
