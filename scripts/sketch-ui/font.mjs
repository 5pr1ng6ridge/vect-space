/**
 * A tiny single-stroke hand-lettering font for logos, stamps and math marks.
 * Glyphs live in a 10 x 14 box (y grows downward, baseline at y = 14) and are
 * drawn with the same pencil as everything else, so they inherit its wobble.
 *
 * Add a glyph by defining strokes: `L(x1, y1, x2, y2)` straight line,
 * `S(...[x, y])` smooth curve through points, `O(cx, cy, rx, ry)` ellipse,
 * `D(x, y)` dot.  Sharp corners must be separate `L` strokes.
 */

const L = (x1, y1, x2, y2) => ({ t: "L", a: [x1, y1, x2, y2] });
const S = (...p) => ({ t: "S", a: p });
const O = (cx, cy, rx, ry) => ({ t: "O", a: [cx, cy, rx, ry] });
const D = (x, y) => ({ t: "D", a: [x, y] });

function lemniscate() {
  const pts = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = (i / 24) * Math.PI * 2;
    const k = 1 + Math.sin(t) ** 2;
    pts.push([
      5 + (5 * Math.cos(t)) / k,
      7 + (4.2 * Math.sin(t) * Math.cos(t)) / k,
    ]);
  }
  return pts;
}

export const GLYPHS = {
  A: [L(0, 14, 5, 0), L(5, 0, 10, 14), L(2, 9.5, 8, 9.5)],
  C: [
    S(
      [9, 2.5],
      [6, 0.3],
      [3, 0.8],
      [1, 4],
      [1, 10],
      [3, 13.2],
      [6, 13.8],
      [9, 11.5],
    ),
  ],
  E: [L(1, 0, 1, 14), L(1, 0, 9.5, 0), L(1, 7, 7, 7), L(1, 14, 9.5, 14)],
  P: [L(1, 14, 1, 0), S([1, 0], [6, 0], [9, 2], [9, 5], [6, 7.5], [1, 7.5])],
  S: [
    S(
      [9, 2.2],
      [6.5, 0.2],
      [3, 0.8],
      [1.5, 3.5],
      [3, 6.5],
      [7, 8],
      [9, 10.5],
      [7.5, 13.2],
      [4, 13.9],
      [1, 11.5],
    ),
  ],
  T: [L(0, 0, 10, 0), L(5, 0, 5, 14)],
  V: [L(0, 0, 5, 14), L(5, 14, 10, 0)],
  B: [
    L(1, 0, 1, 14),
    S([1, 0], [6, 0], [8.5, 1.8], [8.5, 4.8], [6, 6.8], [1, 6.8]),
    S([1, 6.8], [6.5, 6.8], [9.3, 9], [9.3, 11.8], [6.5, 14], [1, 14]),
  ],
  D: [
    L(1, 0, 1, 14),
    S([1, 0], [5, 0], [8.5, 2.5], [9.5, 7], [8.5, 11.5], [5, 14], [1, 14]),
  ],
  F: [L(1, 0, 1, 14), L(1, 0, 9.5, 0), L(1, 7, 7, 7)],
  G: [
    S(
      [9, 2.5],
      [6, 0.3],
      [3, 0.8],
      [1, 4],
      [1, 10],
      [3, 13.2],
      [6, 13.8],
      [9, 11.5],
      [9, 8],
    ),
    L(9, 8, 5.5, 8),
  ],
  H: [L(1, 0, 1, 14), L(9, 0, 9, 14), L(1, 7, 9, 7)],
  I: [L(5, 0, 5, 14), L(2, 0, 8, 0), L(2, 14, 8, 14)],
  J: [
    L(4, 0, 9.5, 0),
    S([8, 0], [8, 10], [7, 13], [4.5, 14], [2, 12.5], [1.2, 10.5]),
  ],
  K: [L(1, 0, 1, 14), L(9, 0, 1, 8), L(3.6, 5.8, 9.5, 14)],
  L: [L(1, 0, 1, 14), L(1, 14, 9, 14)],
  M: [L(0.5, 14, 1.5, 0), L(1.5, 0, 5, 9), L(5, 9, 8.5, 0), L(8.5, 0, 9.5, 14)],
  N: [L(1, 14, 1, 0), L(1, 0, 9, 14), L(9, 14, 9, 0)],
  O: [O(5, 7, 4.6, 7)],
  Q: [O(5, 7, 4.6, 7), L(6, 10, 10, 14.5)],
  R: [
    L(1, 14, 1, 0),
    S([1, 0], [6, 0], [9, 2], [9, 5], [6, 7.5], [1, 7.5]),
    L(4.5, 7.5, 9.5, 14),
  ],
  U: [S([1, 0], [1, 10], [2.5, 13.2], [5, 14], [7.5, 13.2], [9, 10], [9, 0])],
  W: [L(0, 0, 2.5, 14), L(2.5, 14, 5, 5), L(5, 5, 7.5, 14), L(7.5, 14, 10, 0)],
  X: [L(0.5, 0, 9.5, 14), L(9.5, 0, 0.5, 14)],
  Y: [L(0, 0, 5, 7), L(10, 0, 5, 7), L(5, 7, 5, 14)],
  Z: [L(0.5, 0, 9.5, 0), L(9.5, 0, 0.5, 14), L(0.5, 14, 9.5, 14)],
  0: [O(5, 7, 4.2, 7)],
  1: [L(2.5, 3, 5.5, 0), L(5.5, 0, 5.5, 14), L(2.5, 14, 8.5, 14)],
  2: [
    S(
      [1.2, 3.5],
      [3, 0.6],
      [6, 0.2],
      [8.6, 2.4],
      [8.4, 5.6],
      [5, 9.5],
      [1, 14],
    ),
    L(1, 14, 9.5, 14),
  ],
  3: [
    S([1.2, 2.5], [4, 0.2], [7.5, 0.8], [8.5, 3.5], [5.5, 6.5], [3.5, 6.8]),
    S([3.5, 6.8], [7.5, 7.5], [9, 10.5], [7.5, 13.3], [4, 14], [1, 12]),
  ],
  4: [L(7, 14, 7, 0), L(7, 0, 0.5, 10), L(0.5, 10, 9.8, 10)],
  5: [
    L(8.8, 0, 2, 0),
    L(2, 0, 1.5, 6.2),
    S(
      [1.5, 6.2],
      [4.5, 5.2],
      [8, 6.3],
      [9.2, 9.6],
      [7.6, 13.2],
      [4, 14],
      [1, 12.4],
    ),
  ],
  6: [
    S(
      [8.2, 1.2],
      [5.5, 0],
      [2.5, 1.5],
      [1, 6],
      [1.2, 11],
      [3.5, 13.8],
      [6.5, 13.8],
      [8.8, 11.2],
      [8.5, 8],
      [6, 6.3],
      [3, 6.8],
      [1.2, 9],
    ),
  ],
  7: [L(0.5, 0, 9.5, 0), L(9.5, 0, 3.5, 14)],
  8: [O(5, 3.6, 3.6, 3.6), O(5, 10.2, 4.3, 3.8)],
  9: [
    S(
      [8.8, 5],
      [6.5, 7.4],
      [3.5, 7.2],
      [1.2, 4.8],
      [2, 1.5],
      [5, 0],
      [8, 1.2],
      [8.8, 5],
      [8.4, 10],
      [6, 13.6],
      [2.5, 13.8],
    ),
  ],
  ".": [D(5, 13.4)],
  ",": [L(5.5, 12.5, 4, 15.5)],
  ":": [D(5, 4.5), D(5, 12.8)],
  "-": [L(2, 8, 8, 8)],
  "/": [L(9, 0, 1, 14)],
  "(": [S([6.5, 0], [3.8, 3.5], [3.2, 7], [3.8, 10.5], [6.5, 14])],
  ")": [S([3.5, 0], [6.2, 3.5], [6.8, 7], [6.2, 10.5], [3.5, 14])],
  "×": [L(1.5, 3.5, 8.5, 10.5), L(8.5, 3.5, 1.5, 10.5)],
  "∑": [L(9, 0, 1, 0), L(1, 0, 5.5, 7), L(5.5, 7, 1, 14), L(1, 14, 9, 14)],
  π: [
    L(0.5, 2.5, 9.5, 2.5),
    L(2.8, 2.5, 2.8, 14),
    S([7, 2.5], [7, 10], [8, 13.5], [9.6, 13]),
  ],
  "∞": [S(...lemniscate())],
  "∫": [
    S(
      [8.5, 1.5],
      [7.5, 0],
      [6, 0.8],
      [5.5, 4],
      [5, 10],
      [4.5, 13.2],
      [3, 14],
      [1.5, 12.5],
    ),
  ],
  Δ: [L(5, 0, 0, 14), L(0, 14, 10, 14), L(10, 14, 5, 0)],
  "∀": [L(0, 0, 5, 14), L(5, 14, 10, 0), L(2, 6.5, 8, 6.5)],
  "∃": [L(1, 0, 9, 0), L(9, 0, 9, 14), L(9, 14, 1, 14), L(9, 7, 2.5, 7)],
  "→": [L(0, 7, 10, 7), L(6, 3, 10, 7), L(10, 7, 6, 11)],
  "∧": [L(0, 14, 5, 0), L(5, 0, 10, 14)],
  "∨": [L(0, 0, 5, 14), L(5, 14, 10, 0)],
  "¬": [L(0, 5, 10, 5), L(10, 5, 10, 10)],
  "✓": [L(0, 8.5, 3.6, 12.5), L(3.6, 12.5, 10, 0.5)],
  "✗": [L(0.5, 0.5, 9.5, 13.5), L(9.5, 0.5, 0.5, 13.5)],
  "?": [
    S([1.5, 3.5], [2.5, 0.8], [6, 0], [8.5, 2], [8, 5], [5, 7.5], [5, 10]),
    D(5, 13.4),
  ],
  "!": [L(5, 0, 5, 9.5), D(5, 13.2)],
  "=": [L(0, 5, 10, 5), L(0, 10, 10, 10)],
  "+": [L(5, 2, 5, 12), L(0, 7, 10, 7)],
  "⊕": [O(5, 7, 5, 6.5), L(5, 1.5, 5, 12.5), L(0, 7, 10, 7)],
};

/** Horizontal advance of one glyph in glyph units. */
const ADVANCE = 10;
const GAP = 3.2;

export function measureLetters(text, size, spacing = 1) {
  const scale = size / 14;
  const count = [...text].length;
  return (
    count * ADVANCE * scale + Math.max(0, count - 1) * GAP * scale * spacing
  );
}

/**
 * Draw `text` with its baseline at `y` starting at `x`.  `pen` supplies the
 * stroke style; each glyph gets a little random tilt and baseline drift so the
 * lettering reads as hand-made.
 */
export function letters(
  pen,
  text,
  x,
  y,
  size,
  { spacing = 1, tilt = 2.5, drift = 0.04, ...override } = {},
) {
  const scale = size / 14;
  let cursor = x;
  for (const char of text) {
    const glyph = GLYPHS[char] ?? GLYPHS[char.toUpperCase()];
    if (char === " " || !glyph) {
      cursor += (ADVANCE + GAP * spacing) * scale;
      continue;
    }
    const angle = (pen.rng.range(-tilt, tilt) * Math.PI) / 180;
    const dy = pen.rng.range(-drift, drift) * size;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const place = ([gx, gy]) => {
      const px = (gx - ADVANCE / 2) * scale;
      const py = (gy - 7) * scale;
      return [
        cursor + (ADVANCE / 2) * scale + px * cos - py * sin,
        y - 7 * scale + dy + px * sin + py * cos,
      ];
    };
    for (const stroke of glyph) {
      if (stroke.t === "L") {
        const [x1, y1] = place([stroke.a[0], stroke.a[1]]);
        const [x2, y2] = place([stroke.a[2], stroke.a[3]]);
        pen.line(x1, y1, x2, y2, override);
      } else if (stroke.t === "S") {
        pen.path(stroke.a.map(place), override);
      } else if (stroke.t === "O") {
        const [cx, cy] = place([stroke.a[0], stroke.a[1]]);
        pen.ellipse(cx, cy, stroke.a[2] * scale, stroke.a[3] * scale, override);
      } else {
        const [dx, dyy] = place(stroke.a);
        pen.dot(dx, dyy, Math.max(1.6, size * 0.05), override);
      }
    }
    cursor += (ADVANCE + GAP * spacing) * scale;
  }
  return pen;
}
