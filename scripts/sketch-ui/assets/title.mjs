import { PALETTE } from "../canvas.mjs";
import { letters, measureLetters } from "../font.mjs";
import { arrow, highlight, paperPiece, tape } from "../parts.mjs";
import { Pen, ellipsePoints } from "../pencil.mjs";

function background(c) {
  c.add(`<rect width="1920" height="1080" fill="${PALETTE.paperDark}"/>`);
  paperPiece(c, {
    x: 28,
    y: 30,
    w: 1856,
    h: 1010,
    paper: "cream",
    rules: "ruled",
    ruleGap: 40,
    ruleInset: 40,
    outline: { color: PALETTE.paperEdge, width: 2.8, opacity: 0.6 },
  });
  // The left page is deliberately quiet beneath the title card.
  const pen = new Pen(c, { width: 2.8, opacity: 0.55, passes: 2 });
  pen.line(864, 65, 857, 1006, {
    color: PALETTE.paperEdge,
    width: 5,
    opacity: 0.3,
  });
  arrow(pen, 1090, 610, 1570, 610, { head: 16 });
  arrow(pen, 1122, 665, 1122, 305, { head: 16 });
  for (let x = 1182; x < 1560; x += 60)
    pen.line(x, 604, x, 618, { width: 1.6 });
  for (let y = 365; y < 610; y += 60)
    pen.line(1115, y, 1129, y, { width: 1.6 });
  arrow(pen, 1122, 610, 1425, 365, { color: PALETTE.blue, width: 4, head: 22 });
  arrow(pen, 1122, 610, 1530, 492, {
    color: PALETTE.ink,
    width: 3.6,
    head: 20,
  });
  pen.polyline(
    [
      [1425, 365],
      [1530, 492],
      [1122, 610],
    ],
    { width: 1.7, opacity: 0.3 },
  );
  letters(pen, "∑ ∫ π", 1215, 230, 62, { spacing: 1.4, width: 3.4 });
  pen.stroke(ellipsePoints(1540, 529, 70, 44, 6, 3.6, 2.0), {
    color: PALETTE.blue,
    width: 1.8,
    opacity: 0.3,
  });
  pen.line(1304, 659, 1444, 657, { width: 1.8, opacity: 0.28 });
  letters(pen, "∀ ∃", 1292, 716, 30, { width: 2.1, opacity: 0.35 });
  letters(pen, "Δ → ∞", 1030, 875, 46, { width: 2.8, opacity: 0.4 });
  pen.path(
    [
      [1480, 780],
      [1530, 740],
      [1580, 815],
      [1640, 730],
      [1700, 780],
    ],
    { width: 2.3, color: PALETTE.blue, opacity: 0.35 },
  );
  pen.ellipse(1714, 265, 99, 94, {
    color: PALETTE.kraftDark,
    width: 8,
    opacity: 0.28,
    passes: 1,
  });
  pen.stroke(ellipsePoints(1715, 266, 104, 96, 7, 0.4, 4.9), {
    color: PALETTE.kraftDark,
    width: 3.3,
    opacity: 0.22,
    passes: 1,
  });
  for (let i = 0; i < 26; i += 1) {
    const x = c.rng.range(1490, 1790);
    const y = c.rng.range(900, 980);
    pen.line(x, y, x + c.rng.range(2, 8), y + c.rng.range(-3, 4), {
      width: c.rng.range(1.4, 3),
      color: PALETTE.graphiteLight,
      opacity: 0.45,
      passes: 1,
    });
  }
  for (const [x, y, r] of [
    [1440, 947, 24],
    [1510, 995, 19],
    [1760, 865, 28],
  ]) {
    pen.stroke(ellipsePoints(x, y, r, r * 0.55, 4, 0.2, 4.8), {
      color: PALETTE.kraftDark,
      width: 7,
      opacity: 0.45,
      passes: 1,
    });
    pen.stroke(ellipsePoints(x, y, r + 4, r * 0.55 + 3, 4, 0.2, 4.8), {
      color: PALETTE.orange,
      width: 1.6,
      opacity: 0.5,
    });
  }
  // One batched pencil layer keeps the full-screen render affordable.
  c.add(pen.flush());
  tape(c, { x: 72, y: 30, w: 146, h: 34, angle: -3 });
  tape(c, { x: 1690, y: 1016, w: 140, h: 30, angle: 2 });
}

export const assets = [
  {
    name: "title_background",
    dir: "title",
    width: 1920,
    height: 1080,
    note: "Opaque sketchbook spread. Quiet area x136–746/y94–734 for title_card; logo is composited separately.",
    draw: background,
  },
  {
    name: "title_card",
    dir: "title",
    width: 610,
    height: 640,
    textBox: [64, 58, 482, 524],
    draw(c) {
      paperPiece(c, {
        x: 24,
        y: 24,
        w: 558,
        h: 586,
        paper: "light",
        rules: "ruled",
        ruleGap: 40,
        ruleInset: 30,
        edge: "torn",
        torn: [2],
        shadow: { dx: 3, dy: 5, blur: 4, opacity: 0.26 },
      });
      tape(c, { x: 45, y: 17, w: 116, h: 29, angle: -3 });
      tape(c, { x: 446, y: 18, w: 112, h: 28, angle: 3 });
      const pen = new Pen(c, { color: PALETTE.blue, width: 1.8, opacity: 0.4 });
      pen.line(43, 76, 43, 566);
      c.add(pen.flush());
    },
  },
  {
    name: "title_logo",
    dir: "title",
    width: 1000,
    height: 260,
    note: "Approved reference lettering with yellow highlighter swipe.",
    draw(c) {
      highlight(c, {
        x: 60,
        y: 150,
        w: 880,
        h: 56,
        color: PALETTE.highlightYellow,
        opacity: 0.5,
        angle: -1,
      });
      const pen = new Pen(c, {
        color: PALETTE.graphite,
        width: 6.5,
        passes: 3,
        wobble: 1.6,
        opacity: 0.9,
        overshoot: 2,
      });
      const size = 104;
      const width = measureLetters("VECTSPACE", size, 0.7);
      letters(pen, "VECTSPACE", (c.w - width) / 2, 205, size, { spacing: 0.7 });
      c.add(pen.flush());
    },
  },
  ...["a", "b", "c", "d"].map((frame, index) => ({
    name: `loader_${frame}`,
    dir: "title",
    width: 96,
    height: 96,
    seed: "loader",
    note: "Play a–d at 8 fps; fixed centre (48,48).",
    draw(c) {
      const pen = new Pen(c, {
        width: 2.6,
        wobble: 0.8,
        overshoot: 0,
        jitter: 0.5,
      });
      pen.ellipse(48, 48, 28, 28, {
        color: PALETTE.graphiteLight,
        opacity: 0.25,
        width: 1.5,
      });
      const angle = (index * Math.PI) / 2 - Math.PI / 2;
      pen.stroke(ellipsePoints(48, 48, 29, 29, 4, angle, Math.PI * 1.25), {
        width: 4.2,
        color: PALETTE.ink,
        opacity: 1,
      });
      pen.stroke(
        ellipsePoints(48, 48, 32, 30, 4, angle + 0.15, Math.PI * 0.75),
        { width: 1.6, opacity: 0.65 },
      );
      c.add(pen.flush());
    },
  })),
];
