# VECTSPACE

VECTSPACE is a Windows-first visual novel runtime rebuilt with Tauri 2, Rust,
React 19, PixiJS 8, and KaTeX. It deliberately does not support the previous
engine's scripts, saves, or runtime APIs.

## Toolchain

- Node.js `24.19.0` managed by Volta
- Rust stable MSVC (`rustup default stable-msvc`)
- Microsoft Edge WebView2 Runtime
- Windows x64 and NSIS (`currentUser`) packaging

Install the host tools in PowerShell, then restart the terminal:

```powershell
winget install --id Volta.Volta --exact
winget install --id Rustlang.Rustup --exact
winget install --id Microsoft.EdgeWebView2Runtime --exact
volta install node@24.19.0
rustup default stable-msvc
```

Install locked JavaScript packages and run the desktop app:

```powershell
npm ci
npm run tauri dev
```

Useful checks:

```powershell
npm run build
npm test
npm run lint
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run tauri build
```

Both `package-lock.json` and `src-tauri/Cargo.lock` are part of the reproducible
build baseline.

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
double-clicks. Cue IDs are de-duplicated independently of React Strict Mode.

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
background  sprite  say  choice  set  condition  jump  wait
bgm  sfx  camera  screen_effect  dialogue_ui  end
```

Schema v2 declares every variable in `manifest.yaml` with an explicit type,
default, and `save` or `profile` scope. Save variables live in slot snapshots;
profile variables live in `profile.json` and are never rolled back by loading a
slot. Recursive conditions support `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `and`,
`or`, and `not`, and the same expressions can hide or disable individual
choices.

Unknown fields, duplicate YAML keys, missing nodes, wrong asset kinds, invalid
variables, paths outside the content root, invalid ranges, and unsupported schema
versions are rejected before the app starts. Development startup writes editor
schemas under `src-tauri/gen/content-schemas/`.

Dialogue accepts `$...$`, `$$...$$`, `[pause=500ms]`, speed controls, and the
`shake`, `wave`, and `glow` text effects. It never accepts HTML. The renderer lays
out every Chinese character and KaTeX formula first, then reveals units with
`visibility`; hidden content keeps its geometry and formulas reveal atomically.

## Current scope

This first stage includes the VN runtime, fixed viewport, validated content,
Pixi presentation cues, KaTeX dialogue, BGM/SFX infrastructure, settings, a
minimal title screen, automatic save, three manual slots, and NSIS configuration.
History, auto/skip, 30 slots, multiple windows, Lean proof-card gameplay,
and a separate rhythm subsystem remain later milestones.

The copied demo assets and license notice are documented in
`game/assets/THIRD_PARTY.md`. Confirm the ownership of project sample art/audio
before a public release.
