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
[fx=shake]...[/fx]
[fx=wave]...[/fx]
[fx=glow]...[/fx]
\$  \[  \\
```

HTML and scripts are never interpreted. Keep stable node and choice IDs once
content production starts, because save snapshots locate the next story node by
ID.
