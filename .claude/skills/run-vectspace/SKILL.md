---
name: run-vectspace
description: Build, run and drive the VECTSPACE Tauri game (main + secondary window) on Windows. Use when asked to start/launch/run the game, take a screenshot of it, play a scene or chapter-map replay end to end, check native window titles, or verify two-window interaction (blocks, titles, timers, live choices) in the real app instead of unit tests.
---

VECTSPACE is a Tauri 2 visual novel: Rust host (`src-tauri`), React WebViews (`src/`), YAML content (`game/`). An agent drives the **real** app through WebView2's DevTools port with `.claude/skills/run-vectspace/driver.mjs`: it launches `npm run tauri dev`, tells the main and secondary WebView apart, reads/clicks the DOM, sends keys, takes screenshots and reads the native window titles. All paths are relative to the repo root.

Verified on Windows 11, Node v24.19.0, PowerShell 7 (`pwsh`), Rust stable, with `node_modules` already installed. No Linux path was tried (WebView2 is Windows-only).

## Run (agent path)

```powershell
$d = ".claude/skills/run-vectspace/driver.mjs"
node $d launch                # waits (up to 15 min on a cold build) for the title screen
node $d state main            # screen / dialogue / block hint / choices / buttons as JSON
node $d replay window_pair    # title -> 章节地图 -> hotspot; opens the secondary window
node $d titles                # native titles of every visible game window
node $d key secondary Enter; Start-Sleep -Milliseconds 400; node $d key secondary Enter
Start-Sleep -Seconds 3        # main's timer unlocks the choice
node $d state                 # both windows; secondary choice "open" is enabled now
node $d choose secondary open
node $d shot secondary        # -> %TEMP%\vectspace-run\secondary.png
node $d button main 标题       # leave the replay (closes the secondary)
node $d stop
```

| command | what it does |
|---|---|
| `launch` | starts `npm run tauri dev` detached with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`; log `%TEMP%\vectspace-run\tauri-dev.log` |
| `stop` | kills the launched process tree, any `vectspace.exe`, and listeners on 1420/9333; safe to run twice |
| `state [main\|secondary]` | `screen` (`title`/`chapter-map`/`game`/`booting`), dialogue text, block hint, choices (`[disabled]` marked), other buttons |
| `titles` | Win32 window titles of the `vectspace` process (the DOM `document.title` never changes) |
| `replay <hotspotId>` | from the title or chapter map, enters a chapter-map replay (`data-hotspot-id`) |
| `button <win> <text>` | clicks the button whose trimmed text is exactly `<text>` (`标题`, `设置`, `关闭`, `章节地图`, …) |
| `choose <win> <choiceId>` | clicks a choice by id; fails if it is disabled |
| `key <win> <key>` | `Input.dispatchKeyEvent`; `Enter` advances dialogue |
| `shot <win> [file]` | full-window PNG |
| `clips <win> x y w h n ms` | hashes `n` cropped frames (CSS px) — `1 distinct` = static, more = something animates |
| `eval <win> <js>` | evaluates JS in that WebView and prints the JSON result |

The two-window demo (`game/scenes/window_pair_main.yaml` + `window_pair_side.yaml`, hotspot `window_pair`) exercises titles, cross-window block/unblock/scripted advance, a timer that unlocks a choice after ~3 s, and a repeating bounce. Verified sequence: `replay window_pair` → `key secondary Enter` twice (0.4 s apart) → after ~3 s `state secondary` shows `open` enabled → `choose secondary open` → main is renamed, unblocked and advanced one page; secondary now shows `主窗口正在收尾动画，请稍候……` → `key main Enter` finishes both.

Animation check used during verification (main window idle bounce every 1.5 s; this crop covers the sprite at 1280×720 CSS):

```powershell
node .claude/skills/run-vectspace/driver.mjs clips main 400 130 240 150 16 150   # "3 distinct of 16" while bouncing, "1 distinct" after the timer stops
```

## Run (human path)

```powershell
npm run tauri dev   # main window opens at the title screen; close it (or Ctrl-C) to stop
```

The story editor (`editor/`, its own Tauri app) is not covered by this skill.

## Test

```powershell
cargo test --workspace                                # core, host (src-tauri), protocol, editor crate
cargo clippy --workspace --all-targets -- -D warnings
npm test                                              # root vitest: 110 files / 1279 tests at time of writing
npm run build
npm --prefix editor test                              # 57 files / 614 tests
npm run codegen:check                                 # generated schemas/bindings are current
npm run parity:check                                  # real-WebGL shader/presentation parity (needs local Chromium)
```

`npm run lint` currently reports one pre-existing error in `editor/src/components/NodeInspector.presentation.test.tsx:378` (`no-unsafe-assignment`).

## Gotchas

- **Both WebViews report the same URL** (`http://localhost:1420/`) and title (`VECTSPACE`). Identify them by `window.__TAURI_INTERNALS__.metadata.currentWindow.label`; the driver does this for every command.
- **Native titles are not in the DOM.** Window-title nodes call the host's `set_title`; only `titles` (Win32 `EnumWindows`) sees them.
- **A WebView reload does not reset the host.** `location.reload()` shows the title screen while the host still runs the old replay and secondary window; the next `replay` then fails. Use `stop` + `launch`.
- **Rust edits restart the app by themselves** (`tauri dev` rebuilds, new `vectspace.exe` PID, back at the title screen); frontend edits hot-reload through Vite.
- **The first `Enter` may only finish the typewriter.** Send two with a short pause; spamming can skip past the page you wanted.
- **`clips` coordinates are CSS pixels** (main window is 1280×720 CSS); `shot` files are device pixels (2560×1440 main at 200 % scaling here).
- **WebView console errors land in the dev log** as `[vite] (client) [console.error] …` — grep `%TEMP%\vectspace-run\tauri-dev.log` after a scenario.
- **A remounting component is found with a MutationObserver**, e.g. `eval secondary` installing one on `document.body` and logging removed nodes; a flashing `DIV.boot-screen` means the secondary re-bootstrapped.
- **Tauri 2 `listen()` from `@tauri-apps/api/event` hears events for every target.** Host notices are `emit_to(label, …)`; a per-window listener must pass `{ target: <label> }` (see `src/engine/runtimeFeed.ts`) or each window reacts to the other's notices.
- **Save slots are the user's real app data.** Don't save/load slots while testing unless asked.
- The `warning: linker stdout: 正在创建库 …vectspace_lib.dll.lib` during the build is benign.

## Troubleshooting

- **`error: app not running (nothing on CDP port 9333)`**: the app isn't up or was started without the WebView2 flag. Run `launch` (a plain `npm run tauri dev` has no DevTools port).
- **`replay` fails / secondary missing after a reload**: stale host state from a WebView reload. `stop`, then `launch`.
- **`launch` times out**: it prints the last 20 log lines; a Rust compile error shows there. A cold build takes several minutes, a warm one ~20 s.
- **`stop` previously failed with `Command failed: pwsh … Get-NetTCPConnection`** although everything had stopped: that cmdlet sets a failing exit code when nothing listens, even with `-ErrorAction SilentlyContinue`. The driver now ends that script with `exit 0`.
