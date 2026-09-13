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