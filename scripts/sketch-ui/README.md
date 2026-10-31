# Sketch UI art

Procedural "pencil on sketch paper" UI art for VECTSPACE. Every image is drawn by
code in this folder (no image model, no hand-painted files): each asset is a
`draw(c)` function that emits an SVG, which headless Edge/Chrome rasterises to a
transparent PNG the game can load. Generation is seeded from the asset name, so
the same code always draws the same picture.

```
npm run assets:sketch                                   # SVG + stale PNGs + manifest/catalog
node scripts/generate-sketch-ui.mjs --png --force       # re-render every PNG
node scripts/generate-sketch-ui.mjs --file hud --png --sheets --sheet-group hud --guides
```

| Path                                                   | What                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `scripts/sketch-ui/{rng,canvas,pencil,parts,font}.mjs` | shared drawing library (read before drawing)                               |
| `scripts/sketch-ui/assets/<group>.mjs`                 | asset definitions, one module per owner                                    |
| `scripts/sketch-ui/examples/reference.mjs`             | style anchor; not loaded by the generator                                  |
| `art/ui-sketch/svg/<dir>/<name>.svg`                   | generated SVG sources                                                      |
| `game/assets/sketch/<dir>/<name>.png`                  | generated game images (Git LFS)                                            |
| `art/ui-sketch/manifest-assets.yaml`                   | `assets:` entries (`gui.sketch_<name>`) to paste into `game/manifest.yaml` |
| `art/ui-sketch/catalog.json`                           | size, `textBox`, `slice`, `note` per asset for UI integration              |
| `art/ui-sketch/sheets/<dir>[_zoom].png`                | contact sheets on a checkerboard, for review                               |

The PNGs are deterministic for a given browser build; a different Edge/Chrome
version can change anti-aliasing bytes, so only regenerate PNGs whose SVG changed
(the default) unless a full refresh is intended.

## Asset contract

An asset module exports `assets`, an array of:

```js
{
  name: "choice_primary_hover", // [a-z0-9_]+, unique across all modules
  dir: "menu",                  // output sub-folder, [a-z0-9_]+
  width: 980, height: 92,       // integer px; the PNG is exactly this size
  kind: "gui",                  // manifest kind, default "gui"
  seed: "choice_primary",       // optional RNG seed; share it across states
  textBox: [32, 14, 916, 64],   // optional [x, y, w, h] where the game draws text
  slice: [0, 40, 0, 40],        // optional [top, right, bottom, left] 9-slice insets
  note: "label left-aligned",   // optional free text copied into catalog.json
  draw(c) { /* c is a Canvas */ },
}
```

Keep helpers that only one group uses inside that group's module. Shared library
changes go through the art lead so parallel owners never edit the same file.

## Style bible

- **Look**: scraps of notebook/graph/sketch paper taped onto the screen, drawn
  over in graphite with coloured-pencil washes and highlighter swipes. Paper casts
  a soft shadow. Nothing is perfectly straight: large pieces tilt at most ±1.5°,
  small pieces at most ±3°. Lines wobble, overshoot and taper (that is `Pen`).
- **Colour**: only `PALETTE` (canvas.mjs) and the paper tints of `paperPiece`.
  Graphite for line work. `ink`/`blue` for accents and selection. `red` for errors
  and danger. `green` for success. `highlightYellow` for hover and focus. Paper:
  `light`/`white` for interactive items, `cream` for containers, `kraft` for
  secondary items, `yellow` sticky notes for notices, `pink` for errors, `blue`
  for info, `grey` for disabled.
- **Weights**: outlines 2.6–3.4 px. Details 1.4–2.0 px. Rules and grids 1.2–1.6 px,
  faint. Big lettering 5–7 px with 2–3 passes.
- **Texture**: draw strokes with `Pen` (it applies the paper-tooth filter on
  `flush()`). Fill paper with `paperPiece`, colour with `wash`/`highlight`/`shade`.
  Raw `<path stroke>` is only for faint rules. Flush pens into few layers (a
  1920x1080 asset with dozens of filtered layers renders slowly).
- **Transparency**: outside the paper is transparent. Leave at least 12 px of
  canvas around paper so its shadow is not clipped.
- **No body text in images.** The game renders labels, names, dialogue and
  numbers on top. Hand lettering (`letters`) is only for the logo, stamps and
  decorative marks. Everything inside `textBox` must stay plain paper: faint
  rules are fine, but no tape, doodles, margin line or heavy texture. Body text
  is dark navy (`#17213a`), so keep the paper there light.
- **States** are named `<base>_<state>`: `normal`, `hover`, `pressed`,
  `disabled`, plus `selected`, `active`, `on`/`off`, `error`, `complete` where
  meaningful. All states of a base share `seed`, size and geometry. Draw the
  shared base first with one helper and add state extras after it, because the
  extras consume random numbers. Conventions:
  - hover: a yellow highlighter swipe or margin tick, and the scrap lifts (bigger,
    softer shadow).
  - pressed: the scrap is pushed down (offset +2–3 px, tight shadow) with a
    slightly darker paper.
  - disabled: grey paper, graphite at ~45% opacity, no highlight.
  - selected/active: a blue pencil circle, bracket or check.
- **Stretchable containers** (panels, toasts, cards, nodes) declare `slice`.
  Keep tape, folds, stamps and doodles inside the corner regions. Along each edge
  the middle band must look uniform so CSS `border-image` can stretch it.
- **Animation frames** are `<base>_a`, `<base>_b`, ...: same seed and geometry,
  small differences only.

## API cheat sheet

- `Canvas`: `c.w`, `c.h`, `c.rng` (`next`, `range`, `int`, `sign`, `chance`,
  `pick`, `gauss`, `fork(label)`), `c.add(svg...)`, `c.def(svg)`, `c.id(prefix)`,
  `c.layer(svg, {box, kind: "pencil"|"soft"|"wash"|"fiber"|"none", opacity, transform})`,
  `c.shadowFilter({dx, dy, blur, opacity})`.
- `Pen(c, {color, width, opacity, wobble, passes, jitter, overshoot, step, taper, kind})`:
  `line`, `path` (smooth curve through points), `polyline`, `stroke` (dense
  points), `outline` (closed), `rect(x, y, w, h, {r})`, `ellipse`, `hatch(poly, {angle, gap})`,
  `scribble(poly, {angle, gap})`, `dot`. Every method takes a per-call override.
  `flush()` returns the textured layer for `c.add`.
- `parts.mjs`: `paperPiece(c, {x, y, w, h, tilt, paper, edge: "cut"|"round"|"torn", torn, fold, shadow, outline, rules: "ruled"|"grid"|"dots", ruleGap, margin, holes})`
  returns `{poly, inner}`. Also `tape`, `highlight`, `wash`, `shade`,
  `ruledLines`, `gridLines`, `dotGrid`, `marginLine`, `punchHoles`, `scrapPoly`,
  `pathOf`, and the pen marks `checkMark`, `crossMark`, `arrow`, `star`,
  `squiggle`, `cornerMarks`, `circleScribble`.
- `pencil.mjs` geometry: `ellipsePoints`, `roundedRectPoints`, `resample`,
  `smooth`, `boundsOf`, `hatchSegments`.
- `font.mjs`: `letters(pen, text, x, baselineY, size, {spacing, tilt, drift})`
  and `measureLetters(text, size, spacing)`. Caps A–Z (lowercase maps to caps),
  0–9, `. , : - / ( ) ×`, and the math marks `∑ π ∞ ∫ Δ ∀ ∃ → ∧ ∨ ¬ ✓ ✗ ? ! = + ⊕`.

## Review loop

1. `node scripts/generate-sketch-ui.mjs --file <module> --png --sheets --sheet-group <dir> --guides`
   (add `--zoom` for larger cells). Look at `art/ui-sketch/sheets/<dir>.png`;
   image viewers show transparency as black, the sheets use a checkerboard.
2. Check the sheet. Sizes are exact. Nothing is clipped at the canvas edge
   (shadows included). Text boxes (magenta) sit on plain light paper. Slice
   regions (cyan) leave decorations in the corners. States line up when flipped
   between. The set reads as one hand.
3. `npx eslint scripts/sketch-ui` and `npx prettier --write scripts/sketch-ui`.

## Inventory

UI slots follow the 1920x1080 design space in `src/App.css`,
`packages/presentation-react/src/gameplay/gameplay.css`, `choice/choice.css` and
`proof/proof.css`. Boxes are `[x, y, w, h]`.

### hud — `assets/hud.mjs`

| name                                                                                                          | size     | notes                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `dialogue_box`                                                                                                | 1920x387 | textBox `[176, 103, 1572, 239]`. The name plate overlaps the top-left (x 100–464, y < 104). |
| `dialogue_box_grid`                                                                                           | 1920x387 | graph-paper variant, same textBox                                                           |
| `name_box`                                                                                                    | 364x243  | textBox `[54, 78, 246, 44]` (29 px name, centred). Dialogue y = 0 is name_box y = 139.      |
| `continue_a`, `continue_b`                                                                                    | 64x64    | blinking "next" mark frames                                                                 |
| `long_text_page`                                                                                              | 1400x980 | full-page ruled sheet, textBox `[110, 90, 1180, 800]`                                       |
| `notice_strip`                                                                                                | 1100x80  | advance-block notice; textBox `[40, 16, 1020, 48]`, slice                                   |
| `toast_error`, `toast_info`                                                                                   | 900x120  | textBox `[44, 26, 700, 68]`, close button area at the right, slice                          |
| `end_card`                                                                                                    | 520x360  | textBox `[48, 48, 424, 180]`, button below                                                  |
| `tool_save`, `tool_load`, `tool_history`, `tool_settings`, `tool_auto`, `tool_skip`, `tool_hide`, `tool_menu` | 72x72    | toolbar icons, transparent background                                                       |
| `tool_back_hover`, `tool_back_active`                                                                         | 72x72    | backing drawn behind an icon                                                                |
| `scratch_paper`                                                                                               | 480x360  | generic scrap for overlay buttons                                                           |

### menu — `assets/menu.mjs`

| name                                                   | size   | notes                                                                                                  |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------ |
| `choice_primary_{normal,hover,pressed,disabled}`       | 980x92 | textBox `[32, 14, 916, 64]`. An optional 56 px icon sits at x 32 and the label follows 18 px after it. |
| `choice_secondary_{normal,hover,pressed,disabled}`     | 980x92 | different paper (graph/kraft), same textBox                                                            |
| `choice_icon_{lemma,question,warning,lock,star,check}` | 56x56  | icons, transparent                                                                                     |
| `button_{normal,hover,pressed,disabled}`               | 360x64 | modal/end-card button; textBox `[24, 10, 312, 44]`, slice                                              |
| `title_button_{normal,hover,pressed,disabled}`         | 482x60 | left-aligned label, textBox `[20, 8, 442, 44]`                                                         |
| `close_{normal,hover}`                                 | 56x56  |                                                                                                        |
| `checkbox_{off,on}`                                    | 44x44  |                                                                                                        |
| `slider_track`, `slider_fill`                          | 420x32 |                                                                                                        |
| `slider_knob`                                          | 40x40  |                                                                                                        |
| `select_box`                                           | 320x56 | textBox `[18, 8, 250, 40]`, arrow at the right                                                         |
| `tab_{normal,active}`                                  | 220x60 | textBox `[20, 10, 180, 40]`                                                                            |

### title, panel, map — `assets/title.mjs`, `assets/panel.mjs`, `assets/map.mjs`

| name                                     | size      | notes                                                               |
| ---------------------------------------- | --------- | ------------------------------------------------------------------- |
| `title_background`                       | 1920x1080 | The title card sits at x 136–746, y 94–734, so keep that area calm. |
| `title_card`                             | 610x640   | textBox `[64, 58, 482, 524]`                                        |
| `title_logo`                             | 1000x260  | "VECTSPACE" hand lettering (see the reference)                      |
| `loader_{a,b,c,d}`                       | 96x96     | pencil-scribble spinner frames                                      |
| `modal_backdrop`                         | 1920x1080 | translucent dim layer over the game                                 |
| `modal_panel`                            | 1380x900  | notebook page; textBox `[54, 46, 1272, 808]`, slice                 |
| `panel_title_tab`                        | 360x84    | heading tab, textBox                                                |
| `save_slot_{normal,hover,empty}`         | 627x200   | thumbnail window `[18, 18, 240, 135]`, text `[278, 18, 331, 164]`   |
| `empty_thumbnail`                        | 240x135   |                                                                     |
| `history_rule`                           | 1272x28   | divider between history entries                                     |
| `settings_row`                           | 1272x76   | faint row band                                                      |
| `map_background`                         | 1920x1080 | large graph-paper desk map                                          |
| `map_node_{locked,open,current,cleared}` | 240x150   | chapter hotspot card, textBox `[20, 20, 200, 110]`                  |
| `map_hover_card`                         | 480x220   | pointer at the top centre, textBox `[24, 40, 432, 160]`, slice      |
| `map_pin`                                | 64x80     |                                                                     |

### proof — `assets/proof.mjs`

| name                                                | size      | notes                                                                             |
| --------------------------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `proof_background`                                  | 1920x1080 | Header band y 0–150. Palette x 0–300, diagnostics x 1620–1920, canvas in between. |
| `proof_header`                                      | 1920x150  | textBox `[30, 25, 1860, 100]`                                                     |
| `proof_panel_left`, `proof_panel_right`             | 300x930   | slice                                                                             |
| `proof_palette_card_{normal,hover,disabled}`        | 264x96    | textBox `[12, 12, 240, 72]`                                                       |
| `proof_node_{normal,selected,error,complete}`       | 300x240   | header band 0–48 with textBox `[16, 8, 268, 32]`, slice `[56, 24, 24, 24]`        |
| `proof_node_header_{premise,rule,conclusion,lemma}` | 300x52    | tinted header strips                                                              |
| `proof_port_{open,connected,mismatch,local}`        | 28x28     |                                                                                   |
| `proof_status_{complete,incomplete,unavailable}`    | 240x64    | textBox `[16, 10, 208, 44]`                                                       |
| `proof_goal_plate`                                  | 820x88    | textBox `[24, 14, 772, 60]`                                                       |
| `proof_qed_stamp`                                   | 240x240   | "QED" stamp with ∎                                                                |
| `proof_canvas_controls`                             | 1296x64   | slice                                                                             |
