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

### Shared presentation core

`@vectspace/presentation-core` contains the single scene implementation used by
both hosts. There is no second Pixi preview:

```text
packages/presentation-core/src/
├── sceneFrame.ts      pure frame model (geometry, camera, effects, hit test)
├── sceneSurface.ts    the only Pixi Application: objects, textures, cues, thumbnail
├── timelineSession.ts the only timeline clock, event ledger and video sync
├── sceneTextures.ts   reference-counted decoded-texture store
└── deferredSession.ts Strict-Mode-safe per-canvas session lifecycle
```

The game's `PresentationController` and the editor's timeline workspace each own
one `SceneSurface` plus one `TimelineSession` per canvas; neither creates a Pixi
object, edits a camera matrix, or owns a second render loop. The invariants the
shared core guarantees:

- **prepared before committed** — a replacement world decodes every texture
  off-stage and only commits through a token; a superseded request never
  touches the display list, so old visuals stay up while a scene switch loads.
- **one regular render per browser frame** — Pixi's automatic ticker is disabled
  and a single scheduler coalesces every mutation, including cue animations.
- **shared decoded textures, per-instance phases** — one texture store serves
  both hosts, frame loops are per instance, pause freezes without accruing
  debt, scrubbing positions a loop from the playhead, and a changed asset (or a
  fresh context) starts again at frame one.
- **one time authority** — `play()` settles only at the end, skip, cancel or
  failure; scrubbing is silent and deterministic, playback consumes crossed events,
  a backwards seek re-arms the target-and-later events, and a
  zero-time event fires once on the first play.
- **one effect derivation** — flash and shake are evaluated from the playhead
  (latest start wins, equal starts keep array order), shake is composed into the
  camera transform once, and both can be active together.
- **one transition derivation** — background transitions, the persistent
  curtain and parameterised flash/shake are pure functions of the playhead;
  `SceneSurface` only applies the returned alpha/offset/mask/rect geometry, so
  the game, the editor preview and a manual seek all agree on the same pixels.
- **one video policy** — continuous playback corrects drift above 50 ms,
  scrubbing waits for `seeked` plus a presented frame with a diagnostic timeout,
  and the latest seek wins; listeners, frame callbacks, the `VideoSource` and
  the media element are all released with the session.

`@vectspace/presentation-react` holds the DOM counterparts of the same rules:

```text
packages/presentation-react/src/
├── AnimatedImage.tsx      one image element for static or looping artwork
├── useAnimatedImage.ts    per-instance decorative frame clock
├── button/TemplateButton.tsx  the only normal/hover/pressed state machine
├── choice/ChoiceLayer.tsx     the only template-driven choice surface
└── markup/MarkupLabel.tsx     static KaTeX/markup labels
```

The player and the editor preview mount the same `TemplateButton` and
`ChoiceLayer`, so story buttons, choice buttons and the inspector preview cannot
drift apart in artwork resolution, hover/press cancellation, focus handling or
animation playback. `AnimatedImage` is shared too, which means “missing image”
behaves identically in both hosts: the element renders nothing, the failure is
reported, and a caller may fall back to a text skin instead of locking.

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
background  curtain  sprite  say  long_text  long_text_control  choice  set  condition  jump  wait
playback  bgm  sfx  camera  screen_effect  dialogue_ui  timeline  end
```

Background transitions and screen effects have one canonical wire shape. The
loader still accepts the original one-word YAML (`transition: cut`,
`transition: cross_fade`, `effect: flash`, `effect: shake`) and normalises it
into the object form, so old content keeps loading and the WebView only ever
sees one shape:

```yaml
transition:
  type: wipe # cut | cross_fade | fade_through_color | wipe | push
  direction: left_to_right # four edge directions
  softness: 0.08 # 0..1, wipe/push feather
duration_ms: 700
easing: ease_in_out
```

`fade_through_color` carries a `#RRGGBB(AA)` colour. A `cross_fade` honours its
authored easing. `screen_effect` nodes and timeline events share the same
`{ type: flash, color, peak_alpha }` / `{ type: shake, amplitude_x,
amplitude_y, frequency_hz, decay, seed }` spec; the seed is a fixed integer, so
the game, the editor preview and any seek position derive exactly the same
shake. `curtain` is a persistent layer above the world and below screen
effects: `cover` draws a colour or `gui` fill, `reveal` lowers whatever the
current curtain shows, and the animation is `fade`, a four-direction `wipe`,
`split_horizontal` or `split_vertical`. Only the stable cover/fill is saved;
the transition parameters travel exclusively in the cue.

`game/scenes/transition_lab.yaml` is the manual acceptance fixture: it walks
through all five background transitions, the curtain fill/animation matrix and
parameterised, overlapping timeline effects.

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
The game, editor, and Settings sample share the `@vectspace/text` parser, visual
line layout, and reveal clock. A pause is a hard reveal boundary: later content
does not begin until all animations before that marker and the pause itself have
completed. This also makes click-to-complete, auto playback, and Ctrl fast
forward use the same timing rules.
The player can choose `line_sweep`, `typewriter`, or `drop_fade` in Settings;
individual `say` and `long_text` nodes may use `reveal_animation` to override
that preference for a single prompt.

`long_text` is the full-screen alternative to `say` for mathematical exposition.
It displays accumulated `steps` in a positioned scrolling text block. Every click
reveals and confirms one step; each new paragraph is measured and smoothly placed
in the reading area before its text reveal begins. A tall paragraph then follows
its visible cursor through the reading area with bounded, frame-rate-independent
scrolling instead of making a corrective jump. Wheel or drag browsing pauses the
follower and resumes it smoothly at the next story step. Each step has a stable
ID, so saving during a lecture restores the already-written paper without replaying
typing or scrolling. `paper` is
optional: omitting it leaves the block transparent for blackboard-style writing.
`pagination` can be `continuous`, `auto`, or `manual`; automatic mode also accepts
explicit `page_break_before` markers. In automatic mode pagination happens at
measured visual-line boundaries rather than at paragraph boundaries, so a single
long step can safely cross a page while formulas remain atomic. `layout` uses
1920×1080 design pixels.

A document can continue in another node in the same scene. The first node owns
the paper, pagination, font, color, and layout; continuation nodes omit those
fields and reuse the retained, already-resolved steps. `on_exit` may be `hide`,
`keep_visible`, or `close` (the default). A `long_text_control` node can show,
hide, or close a retained document while dialogue, choices, waits, and timelines
run normally around it. Starting a document again replaces its accumulated page;
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

## Loop image animations

A logical image asset is either one static file (`path`) or one loop animation
(`animation`). Exactly one of the two is set, and the asset keeps its `kind`, so
animated artwork can be used in every position that already accepts a
background, sprite or GUI id: Pixi backgrounds, sprites and timeline sprite
tracks, the dialogue box and name plate, long-text paper, button states, the
chapter map, and every preview surface.

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

## Template-driven choices

A `choice` node may opt into a reusable button skin and an explicit placement.
Without `presentation` nothing changes: the buttons keep the shipped CSS panel
at `left: 470px; top: 360px` and the built-in gradient skin, and the runtime
reports the equivalent group-centre anchor so the resolved rects stay
reproducible.

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
The layout is a pure function of order, sizes, direction, gap and anchor — it
never depends on the camera, viewport or frame rate.

`game/scenes/transition_lab.yaml` finishes with a template-driven choice that
demonstrates a KaTeX label, a `gui` icon, the node default template, an option
override template, a filtered option, a disabled option and keyboard focus.

Reusable sprite actions are authored in a full-screen workspace that reuses
the story timeline editor instead of a private keyframe table: the action's
relative channels are projected onto an editable preview pose, parameter-bound
keyframes keep their binding while only their time changes, and editing a
number detaches that keyframe from its parameter. The chapter map keeps
visibility and enterability separate, so a hotspot can be "always shown and
always replayable" to open an unreached chapter (a showcase, an appendix)
without the editor reporting its scene as unreachable.

`game/scenes/presentation_showcase.yaml` is the fixture that exercises an
animated background, animated long-text paper and an animated button. Its
images are generated by `node scripts/make-animation-fixture.mjs`.

## Character expressions and reusable actions

Characters are declared in `manifest.yaml` and keep dialogue styling separate
from stage instance IDs. Each expression can select a sprite asset, anchor,
offset and local scale correction; a `sprite` node may bind a character and
choose an expression. The node may omit `asset` entirely: the selected (or
default) expression supplies the sprite artwork. An explicit `asset` remains
available as an optional override. Omitting the expression uses the character
default. A change of expression preserves the instance transform and can
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

The editor's action library can create, duplicate, rename and delete actions
with reference protection. “解除引用为关键帧时间线” performs an explicit,
reversible conversion using the same relative-track expansion as the runtime;
ordinary action calls remain reusable. The `character_action_showcase` scene
uses the local test portraits, a 28-frame stop-motion sprite and a bounce
action as a small end-to-end fixture.

## Current scope

The runtime includes the fixed viewport, validated Schema v2 content, Pixi
presentation and timeline cues, video tracks, KaTeX dialogue, BGM/SFX buses,
character expressions, reusable sprite actions, loop image animations and
template-driven choices, automatic playback, three Ctrl fast-forward policies,
forced playback sections, profile-level read tracking, a Scene-local 500-entry
dialogue history, three manual slots plus autosave, and the revealed chapter map
page.

Each Scene is a complete runtime boundary. Crossing into another Scene resets
its BGM, background, sprites, buttons, camera/effects, dialogue and long-text
pages, playback/UI state, save-scoped variables, and dialogue history. Profile
variables plus read/seen/completion metadata remain global progression data.
Editor previews always start from the current Scene entry and only replay prior
choices in that Scene; a preview path that leaves the Scene is unreachable.

The independent `sandbox` Scene is always revealed in the chapter map but is not
connected to the player route. It is the editor Scene Entry and Rust
regression fixture for dialogue, formulas, choices, conditions, long-text
continuations, timelines, and playback controls.

The editor includes typed scene graphs, recursive conditions, characters and
variables, a diagnostic sidebar, full-screen timeline and UI-motion workspaces,
direct Pixi object manipulation, and a manually-authored chapter map workspace.
Timeline workspaces instantiate the shared `SceneSurface` and `TimelineSession`
per canvas, so object creation, media lifecycle, effect evaluation and frame
loops are the same code the player runs. Pixi/ELK workspaces are lazy-loaded.
The choice inspector edits the default template, anchor, direction, gap and
optional size overrides plus each option's template and `gui` icon; enabling
presentation on a legacy node seeds the anchor from the resolved legacy-layout
centre, so nothing jumps. Its preview calls the Rust preview run and renders the
returned `PromptSnapshot` through the shared `ChoiceLayer`; it is read-only,
silent, deterministic, cancellable and Strict Mode safe. Icon and button
references (including node and option templates) are counted in the asset and
template lists and protected from deletion.
Saves validate an in-memory candidate and replace only changed documents;
recovery data lives under ignored `.vectspace/backups/` and `.vectspace/tmp/`
directories.

The next gameplay milestone is a generic deterministic mathematics Activity
boundary. Character voice is intentionally out of scope; 30 slots, quick saves,
multiple windows, theorem cards, Lean, and rhythm gameplay remain later work.

The copied demo assets and license notice are documented in
`game/assets/THIRD_PARTY.md`. Confirm the ownership of project sample art/audio
before a public release.
