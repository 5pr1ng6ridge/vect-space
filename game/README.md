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
the exact same shake. `curtain` is a persistent layer above the world: `cover`
draws a colour or `gui` fill, `reveal` lowers the current curtain, and the
animation is `fade`, a four-direction `wipe`, `split_horizontal` or
`split_vertical`. `scenes/transition_lab.yaml` walks through all of them and
finishes with a template-driven `choice` node (KaTeX labels, a `gui` icon, the
node default template, an option override template, a condition-filtered option
and a disabled option).

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
and BGM-volume tracks. Each channel is an ordered list of
`{ at_ms, value, easing }` keyframes; easing controls the segment from that
keyframe to the next. Presets are `step`, `linear`, `ease_in`, `ease_out`, and
`ease_in_out`; custom curves use `{ cubic_bezier: [x1, y1, x2, y2] }`.

Videos are registered as `kind: video` under `assets/videos` and must be MP4
files encoded as H.264 video with AAC audio. Video timelines are always awaited.
Neither video playback position nor transient timeline events are saved: loading
a slot applies the final world snapshot without replaying the presentation.

此game作开发阶段调试用而不公开发行或作引擎样例项目。