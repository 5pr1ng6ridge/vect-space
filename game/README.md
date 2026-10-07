# Content authoring notes

The root manifest registers every scene and every asset. Scene files may refer to
logical IDs such as `bg.vector_space`, never a filename or absolute path.

All IDs use ASCII letters, digits, `.`, `_`, or `-`. Paths are relative to their
declared root and may not contain `..`. YAML uses strict boolean parsing, so only
`true` and `false` are booleans; duplicate map keys are errors.

Nodes that alter stable state first update the target `RuntimeSnapshot`, then emit
their transition cue. Set `await: true` when the next node must not run before the
cue finishes. Non-blocking cues in one update begin concurrently. Use a `wait` or
another awaited node to create an explicit sequence boundary.

Background transitions accept the original one-word form
(`transition: cut|cross_fade`) and the canonical object form
(`{ type: cut|cross_fade|fade_through_color|wipe|push, ... }`); Rust normalises
both into one wire shape. Screen effects are parameterised and shared between
`screen_effect` nodes and timeline events
(`{ type: flash, color, peak_alpha }` / `{ type: shake, amplitude_x,
amplitude_y, frequency_hz, decay, seed }`), with a fixed seed so a seek reproduces
the exact same shake. The shader effects `chromatic_aberration`, `glitch`,
`shockwave`, `color_grade`, `focus` and `ripple` post-process the world layer
only and use the same node/event spec (see the main README for their fields);
`scenes/shader_parity.yaml` is the dedicated fixture behind the browser pixel
assertions of those passes, and `scenes/transition_lab.yaml` demonstrates them.
`curtain` is a persistent layer above the world: `cover`
draws a colour or `gui` fill, `reveal` lowers the current curtain, and the
animation is `fade`, a four-direction `wipe`, `split_horizontal` or
`split_vertical`. `scenes/transition_lab.yaml` walks through all of them and
finishes with a template-driven `choice` node (KaTeX labels, a `gui` icon, the
node default template, an option override template, a condition-filtered option
and a disabled option).

`scenes/visual_showcase.yaml` (chapter-map hotspot `visual_showcase`) shows the
unified Sprite model: the legacy background node, a character, an item and a
screen-space UI image (`source: { type: image }`), the fixed formula block
`text_blocks/formula_card.yaml` as a `source: { type: text }` Sprite, one shared
`sprite.bounce` action on both the item and the text, a persistent snowfall
emitter (`particles/snowfall.yaml`) moved and faded as a whole by a timeline
`emitter` track, and a one-shot `particles/sparkle_burst.yaml` burst. Both
particle definitions use `assets/particles/soft_dot.png`, a generated 32×32
white soft dot.

Dialogue markup:

```text
$...$ and $$...$$
[pause=500ms]
[speed=30cps] and [speed=default]
[auto]（置于句末；文字、公式动画和 pause 完成后立刻推进）
[fx=shake]...[/fx]
[fx=wave]...[/fx]
[fx=glow]...[/fx]
\$  \[  \\
```

HTML and scripts are never interpreted. Keep stable node and choice IDs once
content production starts, because save snapshots locate the next story node by
ID.

A `choice` node is a legacy CSS panel by default. Add `presentation` to reuse a
registered button template and place the group by design-pixel centre
(`anchor_x` 0–1920, `anchor_y` 0–1080, `direction`, `gap`, optional
`button_width`/`button_height`); each option may override the template with
`template:` and add a `gui` `icon:`. Filtering and interpolation run before
layout, missing templates/icons fall back with a diagnostic instead of locking
the story, and a loaded save only contributes option ids, order, labels and
enabled flags. See the root `README.md` for the full rules.

Timeline nodes use an explicit `duration_ms` and contain sprite, camera, video,
BGM-volume, and one ambience-volume track per fixed slot. Each channel is an
ordered list of `{ at_ms, value, easing }` keyframes; easing controls the
segment from that keyframe to the next. Presets are `step`, `linear`, `ease_in`,
`ease_out`, and `ease_in_out`; custom curves use
`{ cubic_bezier: [x1, y1, x2, y2] }`.

## Four-channel ambience

Register environment recordings with `kind: ambience`, then use the fixed
`slot_1`–`slot_4` values in `ambience` nodes. `start` requires an ambience
asset; `stop` omits `asset` and clears only that slot. `volume` is 0–1,
`start_ms` selects the initial phase, and optional loop bounds must be a valid
pair. The four channels share BGM's looping transport but route through a
separate ambience bus and keep phase when the same asset is updated.

```yaml
rain:
  type: ambience
  slot: slot_2
  action: start
  asset: ambience.rain
  volume: 0.5
  start_ms: 0
  duration_ms: 280
  await: true
  next: mix

mix:
  type: timeline
  duration_ms: 1200
  await: true
  skippable: true
  tracks:
    - type: ambience
      slot: slot_1
      channels:
        volume:
          - { at_ms: 0, value: 0.65, easing: linear }
          - { at_ms: 1200, value: 0.2, easing: ease_in_out }
```

A timeline may not repeat a slot track, and only `volume` is automatable.
Cancellation, failed loads, save loads, and Scene changes restore or clear the
snapshot through the shared audio owner rather than leaving a stale transport.
`ambience_lab.yaml` is the reachable four-slot demo. Its four ambience fixtures are
reproducible project-generated WAV files (`npm run assets:ambience`); see
`assets/THIRD_PARTY.md` for exact provenance and the separate notice for unrelated
legacy recordings.

## Secondary window (`open_window`)

The game has exactly one secondary native window. A script asks the host to show
a Scene in it with a non-blocking node:

```yaml
introduce:
  type: say
  text: 让副窗口同时演示环境声。
  next: open_lab

open_lab:
  type: open_window
  scene: ambience_lab
  next: continue_story

continue_story:
  type: say
  text: 副窗口已经打开，主窗口继续推进。
  next: end
```

Rules:

- `scene` names any Scene in the project, including one the main story has not
  reached. `next` stays inside the current Scene, exactly like `say`.
- The node never blocks: the main runtime advances to `next` in the same update
  and emits a host control cue instead of a presentation cue. That cue is
  consumed by the desktop host and never reaches the presentation layer.
- The **main** window's story runtime and a chapter-map **Scene replay** can both
  open or re-point the window; the secondary window itself advances through the
  node normally and opens nothing.
- A replay owns the same single native window while it runs: its own
  `open_window` opens or re-points that one window, and leaving the replayed
  Scene, ending the replay or exiting it closes the window again. Replayed play
  stays ephemeral: its variables and dialogue occurrences never reach the
  official progress, the profile file, a save slot or the merged ledger.
- Opening again **replaces** the Scene shown in the same native window (the
  secondary runtime is rebuilt with a fresh session token). A second window is
  never created.
- One update may contain several requests, because the runtime keeps going past
  every `open_window` node: the **last** one decides what the window shows, and
  no intermediate window is ever created. A request is honoured even when the
  same update also starts a new game or changes Scene — that Scene then owns the
  window, so it is re-pointed instead of being closed first. A new game, a load,
  a title return or a Scene change only closes the previous window when the same
  update carries no request of its own.
- The secondary window has normal gameplay — its own scene, presentation, audio
  and input — but no save, load, settings or history UI, and the host refuses
  those commands from it.
- Save-scoped and profile-scoped variables are shared: the secondary observes
  the main runtime's authoritative maps, and its own writes are published back
  to the main runtime. Leaving a Scene in the secondary preserves the shared
  values; only the main runtime's Scene boundary resets them.
- The merged dialogue history stays in occurrence order across both windows.
  Secondary entries are never dropped when the secondary changes Scene, is
  replaced, or closes; only the main story's established reset points (a new
  game, a load, a main Scene change, or the explicit clear action) remove them.
- The secondary is tied to the runtime that owns it. A story-owned window is
  closed by a main new game, load, return to the title, main Scene change or
  shutdown; a replay-owned one is closed when that replay leaves its Scene,
  ends, fails or is exited, and entering a replay closes a story-owned window
  the replay does not take over. A user/native close of the secondary window is
  prevented; only the host may remove it.
- Saving captures both windows (and the merged history) in one slot; loading a
  slot restores both. Slots written before this feature still load: they simply
  restore the main snapshot without a secondary and without a stored history.

Videos are registered as `kind: video` under `assets/videos` and must be MP4
files encoded as H.264 video with AAC audio. Video timelines are always awaited.
Neither video playback position nor transient timeline events are saved: loading
a slot applies the final world snapshot without replaying the presentation.

此game作开发阶段调试用而不公开发行或作引擎样例项目。