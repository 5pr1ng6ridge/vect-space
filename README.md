# VECTSPACE

VECTSPACE is a Windows-first visual novel runtime built with Tauri 2, Rust,
React 19, PixiJS 8, and KaTeX. Stories are authored as YAML (`game/`), loaded
and validated by Rust, and presented by a React/Pixi frontend. A separate
Tauri application (`editor/`) edits the same YAML as a node graph.

| Document                        | Covers                                              |
| ------------------------------- | --------------------------------------------------- |
| `README.md`                     | toolchain, commands, architecture, content format   |
| `game/README.md`                | content authoring rules and the demo project        |
| `editor/README.md`              | running the story editor, file safety, UI structure |
| `docs/editor-tutorial.zh-CN.md` | step-by-step editor tutorial (Chinese)              |

## Toolchain

- Node.js `24.19.0` managed by Volta
- Rust stable MSVC (`rustup default stable-msvc`)
- Git LFS for binary game assets
- Microsoft Edge WebView2 Runtime
- Windows x64; NSIS (`currentUser`) packaging

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

The repository is both a Cargo workspace and an npm workspace (`editor`,
`packages/*`); the root `Cargo.lock` and `package-lock.json` are the only
lockfiles.

## Commands

| Command                   | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `npm run tauri dev`       | game desktop app with hot reload                           |
| `npm run tauri build`     | game NSIS installer                                        |
| `npm run editor:dev`      | story editor with hot reload                               |
| `npm run editor:build`    | editor NSIS installer (`target/release/bundle/nsis/`)      |
| `npm run build`           | type-check and build the game frontend                     |
| `npm run editor:check`    | type-check and build the editor frontend                   |
| `npm test`                | Vitest for `src/`, `packages/` and `editor/`               |
| `npm run lint`            | ESLint                                                     |
| `npm run format:check`    | Prettier                                                   |
| `npm run assets:check`    | LFS pointer preflight, plus ambience fixture drift check   |
| `npm run assets:ambience` | regenerate the deterministic ambience WAV fixtures         |
| `npm run codegen`         | regenerate JSON schemas and TypeScript protocol bindings   |
| `npm run codegen:check`   | fail when generated files are stale                        |
| `npm run parity:check`    | real-WebGL presentation/shader parity harness (`parity/`)  |
| `cargo test --workspace`  | Rust tests                                                 |
| `npm run check:all`       | tests, builds, `cargo test` and `cargo clippy` in one pass |

`dev` and `build` of both apps run the asset preflight first. If a clone
contains LFS pointer text instead of real images, fonts, audio, or video,
startup stops with the affected paths and the recovery command. Generated
files (`shared/generated/**`) change only through `npm run codegen`; normal
development never writes them.

## Repository layout

```text
crates/vectspace-core      content model, YAML loading and validation, runtime engine
crates/vectspace-protocol  IPC wire types; generates TypeScript bindings
src-tauri/                 game host (resources, saves, windows, commands)
src/                       game frontend
editor/                    story editor (frontend in editor/src, host in editor/src-tauri)
packages/                  shared TypeScript packages
  presentation-core        framework-agnostic scene, timeline, audio and choice-layout logic
  presentation-react       shared React components (dialogue, buttons, choices, long text)
  text, text-react         markup parser, visual layout and reveal clock, KaTeX rendering
game/                      demo project: manifest, scenes, assets (Git LFS)
fixtures/                  cross-language conformance corpora (Rust and TypeScript both consume them)
parity/, scripts/          browser parity harness and repository tooling
docs/                      editor tutorial
```

Shared packages expose subpath exports only (for example
`@vectspace/presentation-core/scene-surface`); there is no package root entry
for the presentation packages.

## Architecture

### Content and hosts

The browser-facing Vite bundle contains UI code only. Game content lives at the
repository root in `game/` (`manifest.yaml`, `scenes/`, `assets/`, and the
sub-documents the manifest lists). In development Rust reads `game/` directly;
the installer maps it to `$RESOURCE/game`. Rust is the only reader of manifest
and scene YAML. At startup it canonicalizes every registered asset, rejects
traversal, and allows only `game/assets` in Tauri's asset protocol. The WebView
receives logical asset IDs resolved to validated paths; it has no filesystem
permission and cannot fetch scene YAML.

`vectspace-core` owns the Tauri-independent content model, validation, runtime,
conditions, interpolation, and timeline evaluation. `vectspace-protocol` owns
IPC boundary values and generates checked-in TypeScript bindings; signed 64-bit
integers cross IPC as canonical decimal strings instead of JavaScript numbers.
The two Tauri crates are host adapters for resources, persistence, windows, and
commands; the editor host reuses the game's content model, validator, and
runtime.

### Snapshot and cues

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

Saves contain only snapshots. The automatic slot and manual slots `1`-`3` use a
temporary file plus backup. Loading cancels transient presentation state and
returns an update with no cues, so SFX, flashes, shakes, and transitions are not
replayed.

### Scene boundary

Each Scene is a complete runtime boundary. Crossing into another Scene resets
BGM, all four ambience slots, background, sprites, buttons, camera and effects,
dialogue and long-text pages, playback/UI state, save-scoped variables, and the
dialogue history (a Scene-local list of at most 500 entries). Profile variables
plus read/seen/completion metadata remain global progression data. Editor
previews start from the current Scene entry and replay only prior choices in
that Scene; a preview path that leaves the Scene is unreachable.

### Fixed viewport

All rendering uses one `1920 x 1080` design space. A single CSS transform
(`src/viewport/`) scales the game viewport; Pixi stays at `1920 x 1080`,
resolution `1`. Extra window area is black. All coordinates in content are
design pixels.

### Shared presentation core

`@vectspace/presentation-core` contains the single scene implementation used by
both hosts. There is no second Pixi preview:

```text
sceneFrame.ts      pure frame model (geometry, camera, effects, hit test)
sceneSurface.ts    the only Pixi Application: objects, textures, cues, thumbnail
timelineSession.ts the only timeline clock, event ledger and video sync
sceneTextures.ts   reference-counted decoded-texture store
deferredSession.ts Strict-Mode-safe per-canvas session lifecycle
```

The game's `PresentationController` and the editor's timeline workspace each own
one `SceneSurface` plus one `TimelineSession` per canvas; neither creates a Pixi
object, edits a camera matrix, or owns a second render loop. The invariants the
shared core guarantees:

- **prepared before committed** - a replacement world decodes every texture
  off-stage and only commits through a token; a superseded request never
  touches the display list, so old visuals stay up while a scene switch loads.
- **one regular render per browser frame** - Pixi's automatic ticker is disabled
  and a single scheduler coalesces every mutation, including cue animations.
- **shared decoded textures, per-instance phases** - one texture store serves
  both hosts, frame loops are per instance, pause freezes without accruing
  debt, scrubbing positions a loop from the playhead, and a changed asset (or a
  fresh context) starts again at frame one.
- **one time authority** - `play()` settles only at the end, skip, cancel or
  failure; scrubbing is silent and deterministic, playback consumes crossed events,
  a backwards seek re-arms the target-and-later events, and a
  zero-time event fires once on the first play.
- **one effect derivation** - every screen effect is evaluated from the
  playhead, one channel per effect type (latest start wins, equal starts keep
  array order); shake is composed into the camera transform once, and all
  channels can be active together.
- **one shader boundary** - the shader effects (see
  [Screen effects](#backgrounds-curtain-and-screen-effects)) are
  post-processing passes on the Pixi world layer only; curtain, flash, session
  curtain and the DOM dialogue/UI stay crisp. `sceneEffects.ts` turns spec +
  playhead + seed into plain uniforms and `sceneShaders.ts` owns the GLSL. Passes
  run in a fixed order (ripple, shockwave, glitch, colour grade, focus H/V,
  chromatic aberration), clamp displaced samples to the stage edge, skip any
  pass whose intensity or geometry is a no-op, and an idle scene installs no
  filter at all. The player's `reduce_motion` setting caps flashes, scales down
  shake and shader intensity, disables ripple and skips the focus blur (keeping
  the optional darkening) on both the timeline and the cue path.
- **one transition derivation** - background transitions, the persistent
  curtain and parameterised flash/shake are pure functions of the playhead;
  `SceneSurface` only applies the returned alpha/offset/mask/rect geometry, so
  the game, the editor preview and a manual seek all agree on the same pixels.
- **one video policy** - continuous playback corrects drift above 50 ms,
  scrubbing waits for `seeked` plus a presented frame with a diagnostic timeout,
  and the latest seek wins; listeners, frame callbacks, the `VideoSource` and
  the media element are all released with the session.

The shared `AudioManager` exposes defensive, read-only `AudioDiagnostics`
(dedicated bus gain, per-slot asset, volume, phase and paused state) for host
diagnostics and browser parity; the game controller and editor
`TimelineSession` use the same seam.

`@vectspace/presentation-react` holds the DOM counterparts of the same rules:
`AnimatedImage` (static or looping artwork), `button/TemplateButton` (the only
normal/hover/pressed state machine), `choice/ChoiceLayer` (the only
template-driven choice surface), `markup/MarkupLabel` (static KaTeX/markup
labels) and the `gameplay` components (dialogue box, long-text panel, button
layer, scene canvas). The player and the editor preview mount the same
components, so story buttons, choice buttons and inspector previews cannot drift
apart in artwork resolution, hover/press cancellation, focus handling or
animation playback. A missing image behaves identically in both hosts: the
element renders nothing, the failure is reported, and a caller may fall back to
a text skin instead of locking.

## Content format

`game/manifest.yaml` (Schema v2) registers everything: `variables`,
`characters`, `assets`, `scenes`, and the sub-document lists `ui_motions`,
`buttons`, `animations`, `actions`, `text_blocks`, `particles` and
`chapter_map`. Scene files refer to logical IDs such as `bg.vector_space`, never
to filenames. Authoring rules for IDs, cue ordering and the demo project are in
`game/README.md`.

Variables are declared in the manifest with an explicit type, default, and
`save` or `profile` scope. Save variables live in slot snapshots; profile
variables live in `profile.json` and are never rolled back by loading a slot.
Recursive conditions support `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `and`, `or`,
and `not`, and the same expressions can hide or disable individual choices.

Unknown fields, duplicate YAML keys, missing nodes, wrong asset kinds, invalid
variables, paths outside the content root, invalid ranges, and unsupported
schema versions are rejected before the app starts.

Node types, by group:

```text
narrative  say  long_text  long_text_control
logic      choice  set  condition  jump  wait  end
visual     background  curtain  sprite  particle  action  clear  camera
           screen_effect  timeline
audio      bgm  sfx  ambience
interface  dialogue_ui  ui_motion_set  ui_motion_play
           button_create  button_update  button_remove
flow       playback
windows    open_window  window_title  window_control  window_geometry
           window_layer  timer
```

### Backgrounds, curtain and screen effects

Background transitions and screen effects are written as a tagged object, which
is also the only shape the WebView sees. A one-word `transition: cut|cross_fade`
is still accepted and normalised by Rust.

```yaml
transition:
  type: wipe # cut | cross_fade | fade_through_color | wipe | push
  direction: left_to_right # four edge directions
  softness: 0.08 # 0..1, wipe/push feather
duration_ms: 700
easing: ease_in_out
```

`fade_through_color` carries a `#RRGGBB(AA)` colour. A `cross_fade` honours its
authored easing. `screen_effect` nodes and timeline events share one spec union
(positions and lengths in design pixels, `fade_in + fade_out <= 1`, every field
optional with a default, fixed integer `seed` so the game, editor preview and any
seek position derive the same pattern):

| `type`                 | fields                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `flash`                | `color`, `peak_alpha`                                                                                     |
| `shake`                | `amplitude_x`, `amplitude_y`, `frequency_hz`, `decay`, `seed`                                             |
| `chromatic_aberration` | `intensity`, `angle_deg`, `center_x`, `center_y`, `edge_weight`, `fade_in`, `fade_out`                    |
| `glitch`               | `displacement`, `slice_count`, `density`, `frequency_hz`, `seed`, `fade_in`, `fade_out`                   |
| `shockwave`            | `center_x`, `center_y`, `max_radius`, `wave_width`, `strength`                                            |
| `color_grade`          | `brightness`, `contrast`, `saturation`, `tint`, `tint_strength`, `intensity`, `fade_in`, `fade_out`       |
| `focus`                | `center_x`, `center_y`, `radius`, `softness`, `blur`, `darkness`, `intensity`, `fade_in`, `fade_out`      |
| `ripple`               | `center_x`, `center_y`, `amplitude`, `wavelength`, `speed`, `damping`, `intensity`, `fade_in`, `fade_out` |

`color_grade` is a straight-RGB grade mixed by the enveloped `intensity` (a
neutral grade - the default - bypasses entirely). `focus` keeps the `radius` disc
sharp and appears only outside `radius + softness`, with a bounded separable
Gaussian `blur` and a one-pass `darkness`. `ripple` is a signed periodic
concentric displacement (not an expanding shockwave ring).

`curtain` is a persistent layer above the world and below screen effects:
`cover` draws a colour or `gui` fill, `reveal` lowers whatever the current
curtain shows, and the animation is `fade`, a four-direction `wipe`,
`split_horizontal` or `split_vertical`. Only the stable cover/fill is saved; the
transition parameters travel exclusively in the cue.

### Text and long text

Dialogue accepts `$...$`, `$$...$$`, `[pause=500ms]`, speed controls, and the
`shake`, `wave`, and `glow` text effects (full markup in `game/README.md`). It
never accepts HTML. The renderer lays out every Chinese character and KaTeX
formula first, then reveals units with `visibility`; hidden content keeps its
geometry and formulas reveal atomically. The game, editor, and Settings sample
share the `@vectspace/text` parser, visual line layout, and reveal clock. A
pause is a hard reveal boundary: later content does not begin until all
animations before that marker and the pause itself have completed, so
click-to-complete, auto playback, and Ctrl fast forward use the same timing
rules. The player can choose `line_sweep`, `typewriter`, or `drop_fade` in
Settings; individual `say` and `long_text` nodes may use `reveal_animation` to
override that preference.

`long_text` is the full-screen alternative to `say` for mathematical exposition.
It displays accumulated `steps` in a positioned scrolling text block. Every click
reveals and confirms one step; each new paragraph is measured and smoothly placed
in the reading area before its text reveal begins, and a tall paragraph is
followed with bounded, frame-rate-independent scrolling. Wheel or drag browsing
pauses the follower until the next story step. Each step has a stable ID, so a
save restores the already-written paper without replaying typing or scrolling.
`paper` is optional: omitting it leaves the block transparent for
blackboard-style writing. `pagination` can be `continuous`, `auto`, or `manual`;
automatic mode also accepts explicit `page_break_before` markers and paginates at
measured visual-line boundaries, so a long step can cross a page while formulas
remain atomic. `layout` uses 1920x1080 design pixels.

A document can continue in another node of the same Scene. The first node owns
the paper, pagination, font, color, and layout; continuation nodes omit those
fields and reuse the retained, already-resolved steps. `on_exit` may be `hide`,
`keep_visible`, or `close` (the default). A `long_text_control` node can show,
hide, or close a retained document while dialogue, choices, waits, and timelines
run around it. Starting a document again replaces its accumulated page;
continuing a missing or closed document is a content error.

```yaml
lecture:
  type: long_text
  document: amgm # optional; defaults to this node's ID
  mode: start # start (default) or continue
  on_exit: keep_visible # hide, keep_visible, or close (default)
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

lecture_continue:
  type: long_text
  document: amgm
  mode: continue
  on_exit: close
  steps:
    - id: proof
      page_break_before: true
      text: "由 $(a-b)^2\\ge 0$ 可得……"
  next: next_node

hide_notes:
  type: long_text_control
  document: amgm
  action: hide # show, hide, or close
  next: next_node
```

### Loop image animations

A logical image asset is either one static file (`path`) or one loop animation
(`animation`). Exactly one of the two is set, and the asset keeps its `kind`, so
animated artwork can be used wherever a background, sprite or GUI id is
accepted: Pixi backgrounds, sprites and timeline sprite tracks, the dialogue box
and name plate, long-text paper, button states, the chapter map, and every
preview surface.

Animations live in their own Schema v1 documents, listed in the manifest:

```yaml
# manifest.yaml
assets:
  gui.dialogue_pulse:
    kind: gui
    animation: anim.dialogue_pulse
  gui.dialogue_pulse_a:
    kind: gui
    path: gui/anim_dialogue_pulse_a.png
  gui.dialogue_pulse_b:
    kind: gui
    path: gui/anim_dialogue_pulse_b.png
animations:
  - animations/dialogue_pulse.yaml
```

```yaml
# animations/dialogue_pulse.yaml
schema_version: 1
id: anim.dialogue_pulse
frames:
  - asset: gui.dialogue_pulse_a # static image asset id only
    duration_ms: 900
  - asset: gui.dialogue_pulse_b
    duration_ms: 900
```

Rules enforced at load, preview and save time, not only in the editor:

- Frames play in list order and loop forever. A ping-pong animation repeats
  frames instead of declaring a direction.
- A frame may only reference a _static_ image asset; animations cannot nest.
- Every frame of one animation must share one pixel size. The core reads the
  real PNG/JPEG/GIF/WebP header of each frame, so a hand-written document is
  checked exactly like an imported one; transparent margins are how differing
  artwork is aligned.
- Frame durations are 1-60000 ms, frame count is at most 512, and the unique
  frames of one animation must fit a 256 MiB decoded-RGBA budget.
- An animation id must not collide with an asset id, and an image used by an
  animation cannot be deleted without addressing that animation.

Frame loops are _decorative_ animations:

- Ctrl fast forward accelerates tweens and text only, never a frame loop.
- Opening a menu, hiding the page or losing focus pauses the loop; resuming
  continues on the same frame and never repays the paused time.
- A save stores the asset id and stable instance state only - no frame index,
  loop count or progress - so loading always restarts an animation on its
  first frame.
- Moving, scaling or re-applying the same snapshot does not restart a loop.
  Changing the asset, including switching an animation for another one, does.
- Instances share decoded frame textures but never a playback position.
- Layout uses the animation's measured size, so switching frames never moves or
  resizes an object, and layout measurements (KaTeX, paper pagination, button
  hit areas) are never rebuilt per frame.

### Template-driven choices

A `choice` node may opt into a reusable button skin and an explicit placement.
Without `presentation` the buttons keep the built-in CSS panel and gradient
skin, and the runtime reports the equivalent group-centre anchor so the
resolved rects stay reproducible.

```yaml
route_choice:
  type: choice
  presentation:
    template: choice.primary # reusable ButtonTemplate, optional
    anchor_x: 960 # group centre, design pixels 0..=1920
    anchor_y: 780 # group centre, design pixels 0..=1080
    direction: horizontal # vertical (default) or horizontal
    gap: 24 # design pixels between items
    button_width: 400 # optional node-wide override
    button_height: null # optional node-wide override
  choices:
    - id: formula
      label: "勾股定理 $a^2+b^2=c^2$"
      icon: gui.dialogue_box # optional `gui` asset
      next: next_node
    - id: compact
      label: 更窄的选项
      template: choice.secondary # wins over the node template
      next: next_node
```

Rules the runtime enforces:

- Filtering and interpolation run before layout, so a hidden option never
  consumes a flow slot and labels always reflect the current variables.
- Size priority is node override, then option template, then node template,
  then the documented `980x92` fallback; every item is centred on the cross
  axis and the group is centred on the anchor.
- Anchors are **design pixels**, never normalized fractions: `(960, 540)` is the
  stage centre, `(0, 0)` touches the top-left corner, and any value outside
  `0..=1920` / `0..=1080` is reported and replaced by the default.
- A missing or wrong-kind icon, a missing node or option template, a negative
  gap and a non-positive size override become structured `diagnostics` on the
  prompt instead of locking the story. The item falls back to the node template
  or to the built-in CSS button, and the game surfaces the message once.
- A save only contributes identity and interaction state: ids, order, labels
  and enabled flags are kept, while rects, templates, icons and diagnostics are
  always re-resolved from the current content. Saved ids that no longer exist
  are dropped, and a loaded prompt that would end up empty or fully disabled is
  rejected rather than deadlocking the player.
- Buttons are native DOM buttons: normal, hover, pressed, disabled and
  keyboard-focus states all work, `:focus-visible` draws the ring, and focus
  survives a harmless re-render but is released when the prompt changes.

`fixtures/choice-layout-cases.json` is the shared conformance corpus: the Rust
layout in `crates/vectspace-core/src/choice.rs` and the framework-agnostic
mirror in `@vectspace/presentation-core/choice-layout` must both reproduce it.
The layout is a pure function of order, sizes, direction, gap and anchor - it
never depends on the camera, viewport or frame rate.

### Ambience

Ambience is a dedicated looping audio bus with exactly four stable channels:
`slot_1`, `slot_2`, `slot_3`, and `slot_4`. Slot identity is part of the
runtime audio snapshot and timeline sidecar only; it is deliberately not a
`SceneFrame`/Pixi object. BGM keeps its single loop and SFX remains one-shot
audio.

```yaml
forest:
  type: ambience
  slot: slot_1
  action: start # start or stop
  asset: ambience.birds # required for start; omitted for stop
  volume: 0.65
  start_ms: 0
  duration_ms: 280
  await: true
  next: next_node
```

A `timeline` may contain one `ambience` track per fixed slot. Tracks automate
only `volume`; when a timeline ends, is cancelled, or is replaced, the
authoritative snapshot volume is restored. Replacing the same asset preserves
its playback phase - a same-asset `start` update rewrites gain, `loop_start_ms`
and `loop_end_ms` in place and never seeks, so `start_ms` only applies to the
initial start of that element - while a different asset crossfades in
isolation. Scene boundaries stop every active slot. Snapshots that omit
ambience (or use `ambience: null`) still load.

`loop_start_ms`/`loop_end_ms` are authored together. Without them the element
loops the whole file natively; with explicit bounds a custom rewind fires 25 ms
before the loop end, driven by `timeupdate`, whose cadence is browser-defined -
it can be far coarser than 25 ms and overshoot the end, so it is not
sample-accurate - and an `ended` fallback recovers a loop that ends at the
media's own EOF.

### Characters and reusable actions

Characters are declared in `manifest.yaml` and keep dialogue styling separate
from stage instance IDs. Each expression can select a sprite asset, anchor,
offset and local scale correction; a `sprite` node may bind a character and
choose an expression. The node may omit `asset`: the selected (or default)
expression supplies the artwork, and an explicit `asset` remains an optional
override. A change of expression preserves the instance transform and can
cross-fade the old and new artwork without changing the dialogue layout.

```yaml
characters:
  alli:
    display_name: 艾莉
    name_color: "#80D8FF"
    text_color: "#FFFFFF"
    default_expression: neutral
    expressions:
      neutral: { asset: sprite.alli_neutral, anchor_x: 0.5, anchor_y: 1 }
      smug: { asset: sprite.alli_smug, anchor_x: 0.5, anchor_y: 1 }
```

Reusable sprite actions live in Schema v1 documents listed by
`manifest.actions`. Their channels are relative to the target's current pose:
position and rotation are offsets, while scale and opacity are multipliers.
Parameters are range-checked by Rust and may be overridden at the call site;
`end: restore` adds a final keyframe returning to the captured pose.

```yaml
type: action
sprite_id: alli
action: sprite.bounce
await: true
next: next_line
```

### Unified Sprites, text blocks and particles

Backgrounds, characters, items, standalone UI images and fixed text blocks are
all instances in `world.sprites` and share one source/layout/transform model:

```yaml
type: sprite
sprite_id: caption
action: show
source: { type: text, text_block: text.formula_card } # or { type: image, asset: gui.badge }
sprite_kind: text # background | character | item | ui | text - creation defaults only
space: screen # world follows the camera/shake/world shaders; screen does not
layout: { width: 760, height: 260, fit: contain } # optional; contain | cover | stretch
x: 960
y: 540
rotation_deg: -2
```

`sprite_kind` only seeds a _new_ instance (background: 1920x1080 cover at the
bottom z; character: bottom-centre anchor; ui: screen space); omitted fields of
a later `move` inherit the current pose. `source` cannot be combined with the
legacy `asset`/`character` fields, which keep working unchanged. A legacy
`background` node or save field is adapted at the boundary into the reserved
`__background__` instance; new saves write only Sprites, and authoring that
reserved id is a validation error. World Sprites, text, video and emitters
interleave by `z`; screen-space visuals sit above the world and below
transitions, effects and curtains. Interactive buttons and the dialogue box
stay DOM controls.

Fixed text blocks (`manifest.text_blocks`, e.g. `text_blocks/*.yaml`) reuse the
dialogue markup and KaTeX (`trust: false`) - no typing, pagination or
click-to-advance. Each definition is rasterized once off-stage with the project
(or default) font and KaTeX fonts embedded, then shared by every Sprite that
names it; moving, scaling or rotating never re-lays-out the text. The texture
key includes the definition, font URL, font byte hash and resolution. Limits:
4096x4096 and 4,194,304 pixels per block, 16,384 characters, fonts up to 16 MiB
(enforced while streaming) and an 8 s generation timeout.

Image particles (`manifest.particles`, e.g. `particles/*.yaml`) reference one
static image of at most 512x512 and are driven by `particle` nodes:

```yaml
type: particle
emitter_id: snow
action: start # start (persistent, saved) | stop | burst (one-shot cue, never saved)
particle: particle.snowfall
space: world
x: 960
y: -40
scale: 1
rotation_deg: 0
opacity: 1
z: 20
```

Each emitter is one Pixi `ParticleContainer` with preallocated particles and a
reused buffer; particles are evaluated analytically from seed, emission index
and age, so seeking is O(capacity) and never replays from zero. Caps are 5,000
live particles per emitter and 10,000 per surface. A persistent emitter saves
its definition, seed, generation and whole pose in `world.emitters`; loading a
save restarts it from its seed (like decorative frame loops), and bursts are
never replayed. Particles share the surface's single render loop - no extra
RAF, interval or DOM - pause without catch-up, and are valid nonblocking timer
targets. Timelines may animate a persistent emitter as a whole (`type: emitter`,
channels `x/y/scale/rotation_deg/opacity/z`); individual particles are never
selectable or addressable. Reusing an `emitter_id` restarts or stops that
instance.

### Demo scenes

`game/scenes/` doubles as the acceptance and regression fixture set:

| Scene                                  | Exercises                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `prologue`                             | two-route demo: transitions, formulas, SFX, choices, variables, camera, effects, saves                                                         |
| `sandbox`                              | always-revealed chapter-map scene and editor Scene Entry: dialogue, choices, conditions, long-text continuations, timelines, playback controls |
| `transition_lab`                       | all five background transitions, the curtain matrix, parameterised overlapping effects, a template-driven choice                               |
| `shader_parity`, `surface_parity`      | fixtures behind the `parity/` browser pixel assertions                                                                                         |
| `ambience_lab`                         | four-slot ambience: start, independent automation, same-asset retune, cross-asset replace, stop                                                |
| `presentation_showcase`                | animated background, animated long-text paper and an animated button (`scripts/make-animation-fixture.mjs` generates its images)               |
| `character_action_showcase`            | character expressions, a 28-frame stop-motion sprite and a bounce action                                                                       |
| `visual_showcase`                      | unified Sprites, fixed text blocks, shared actions and particles                                                                               |
| `window_pair_main`, `window_pair_side` | two-window demo (see `game/README.md`)                                                                                                         |

The four ambience demo files are deterministic WAV fixtures
(`npm run assets:ambience`); `game/assets/THIRD_PARTY.md` records provenance and
the separate notice for unrelated legacy recordings. Confirm ownership of the
project's sample art and audio before a public release.

## Story editor

`editor/` is a separate Tauri application for editing the YAML story as a
directed node graph. It supports every node type, keeps layout metadata outside
scene YAML (`game/.vectspace/layout-v1.json`), and validates the complete
project before an atomic save. Its timeline, long-text and preview workspaces
instantiate the shared `SceneSurface`, `TimelineSession`, `LongTextPanel` and
`ChoiceLayer`, so previews run the same code as the player. See
`editor/README.md` for running it and `docs/editor-tutorial.zh-CN.md` for usage.
