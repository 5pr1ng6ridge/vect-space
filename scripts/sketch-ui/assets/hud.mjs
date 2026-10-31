import { PALETTE } from "../canvas.mjs";
import {
  circleScribble,
  highlight,
  gridLines,
  marginLine,
  paperPiece,
  ruledLines,
  shade,
  tape,
} from "../parts.mjs";
import { Pen } from "../pencil.mjs";

const dialogueText = [176, 103, 1572, 239];

function dialogue(c, rules = "ruled") {
  paperPiece(c, {
    x: 120,
    y: 60,
    w: 1680,
    h: 298,
    edge: "torn",
    torn: [0],
    tilt: -0.4,
    paper: "cream",
    shadow: { dx: 4, dy: 6, blur: 5, opacity: 0.34 },
  });
  // Isolate rule randomness so the paper outline and tape match both variants.
  const baseRng = c.rng;
  c.rng = baseRng.fork("rules");
  const rulesSvg =
    rules === "grid"
      ? gridLines(c, 130, 70, 1660, 278, { gap: 32, opacity: 0.4 })
      : ruledLines(c, 120, 60, 1680, 298, {
          gap: 44,
          inset: 40,
          top: 84,
          opacity: 0.7,
        });
  c.add(`<g transform="rotate(-0.4 960 209)">${rulesSvg.join("")}</g>`);
  c.rng = baseRng;
  tape(c, { x: 560, y: 40, w: 130, h: 38, angle: -6 });
  tape(c, { x: 1630, y: 44, w: 130, h: 38, angle: 6 });
}

function namePlate(c) {
  paperPiece(c, {
    x: 22,
    y: 54,
    w: 320,
    h: 151,
    paper: "light",
    tilt: -1,
    shadow: { dx: 2, dy: 3, blur: 3, opacity: 0.24 },
  });
  highlight(c, { x: 48, y: 139, w: 230, h: 12, opacity: 0.4, angle: -1 });
  tape(c, { x: 40, y: 194, w: 76, h: 28, angle: -9 });
  tape(c, { x: 255, y: 192, w: 62, h: 30, angle: 8 });
}

function iconPen(c) {
  return new Pen(c, {
    width: 3.2,
    wobble: 0.8,
    jitter: 0.65,
    overshoot: 1.3,
    step: 3,
    opacity: 0.95,
  });
}

const iconDrawings = {
  save(p) {
    p.polyline([
      [17, 16],
      [49, 16],
      [56, 23],
      [56, 56],
      [17, 56],
      [17, 16],
    ]);
    p.polyline(
      [
        [26, 17],
        [26, 31],
        [46, 31],
        [46, 17],
      ],
      { width: 1.8 },
    );
    p.rect(25, 40, 23, 15, { width: 1.8, crossing: 0 });
    p.line(40, 20, 40, 27, { width: 2 });
  },
  load(p) {
    p.polyline([
      [16, 48],
      [16, 21],
      [31, 21],
      [37, 28],
      [54, 28],
      [54, 34],
    ]);
    p.polyline([
      [15, 54],
      [22, 34],
      [59, 34],
      [52, 54],
      [15, 54],
    ]);
    p.line(24, 27, 29, 27, { width: 1.6 });
  },
  history(p) {
    p.ellipse(37, 36, 21, 21);
    p.line(37, 23, 37, 37);
    p.line(37, 37, 47, 42);
    p.polyline(
      [
        [11, 23],
        [12, 35],
        [23, 31],
      ],
      { width: 2.6 },
    );
  },
  settings(p) {
    const points = [];
    for (let tooth = 0; tooth < 8; tooth += 1) {
      for (const [offset, radius] of [
        [-0.38, 18],
        [-0.24, 24],
        [0.24, 24],
        [0.38, 18],
      ]) {
        const angle = (tooth * Math.PI) / 4 + offset;
        points.push([
          36 + Math.cos(angle) * radius,
          36 + Math.sin(angle) * radius,
        ]);
      }
    }
    p.outline(points, { jitter: 0.3, wobble: 0.4 });
    p.ellipse(36, 36, 8, 8, { width: 2.4 });
  },
  auto(p) {
    p.polyline([
      [30, 19],
      [54, 36],
      [30, 53],
      [30, 19],
    ]);
    p.line(15, 26, 23, 26, { width: 1.8 });
    p.line(12, 36, 23, 36, { width: 1.8 });
    p.line(15, 46, 23, 46, { width: 1.8 });
  },
  skip(p) {
    p.polyline([
      [17, 21],
      [33, 36],
      [17, 51],
    ]);
    p.polyline([
      [37, 21],
      [53, 36],
      [37, 51],
    ]);
  },
  hide(p) {
    p.path([
      [14, 28],
      [24, 37],
      [36, 40],
      [48, 37],
      [58, 28],
    ]);
    p.line(20, 34, 15, 42, { width: 2.4 });
    p.line(29, 39, 27, 48, { width: 2.4 });
    p.line(43, 39, 45, 48, { width: 2.4 });
    p.line(52, 34, 57, 42, { width: 2.4 });
  },
  menu(p) {
    p.line(17, 23, 55, 23);
    p.line(17, 36, 55, 36);
    p.line(17, 49, 55, 49);
  },
};

function toast(c, error) {
  paperPiece(c, {
    x: 16,
    y: 16,
    w: 866,
    h: 88,
    paper: error ? "pink" : "blue",
    shadow: { dx: 2, dy: 3, blur: 2, opacity: 0.25 },
  });
  const p = new Pen(c, {
    color: error ? PALETTE.red : PALETTE.blue,
    width: 3.2,
  });
  p.polyline([
    [28, 44],
    [28, 28],
    [38, 28],
  ]);
  c.add(p.flush());
}

export const assets = [
  {
    name: "dialogue_box",
    dir: "hud",
    width: 1920,
    height: 387,
    seed: "hud_dialogue",
    textBox: dialogueText,
    note: "Place at screen bottom. Overlay name_box at x=100, y=-139; tape stays clear of that plate.",
    draw: (c) => dialogue(c),
  },
  {
    name: "dialogue_box_grid",
    dir: "hud",
    width: 1920,
    height: 387,
    seed: "hud_dialogue",
    textBox: dialogueText,
    note: "Graph-paper alternative; same name plate placement and text bounds as dialogue_box.",
    draw: (c) => dialogue(c, "grid"),
  },
  {
    name: "name_box",
    dir: "hud",
    width: 364,
    height: 243,
    textBox: [54, 78, 246, 44],
    note: "Draw above dialogue at x=100, y=-139. Bottom tape bridges the plate and dialogue paper; centre the 29px speaker name.",
    draw: namePlate,
  },
  ...["a", "b"].map((frame) => ({
    name: `continue_${frame}`,
    dir: "hud",
    width: 64,
    height: 64,
    seed: "hud_continue",
    note: "Alternate opacity only; no movement between frames.",
    draw(c) {
      const p = iconPen(c);
      p.polyline([
        [19, 23],
        [32, 37],
        [45, 23],
      ]);
      p.polyline(
        [
          [23, 34],
          [32, 44],
          [41, 34],
        ],
        { width: 1.8 },
      );
      c.add(p.flush({ opacity: frame === "a" ? 1 : 0.65 }));
    },
  })),
  {
    name: "long_text_page",
    dir: "hud",
    width: 1400,
    height: 980,
    textBox: [110, 90, 1180, 800],
    draw(c) {
      paperPiece(c, {
        x: 40,
        y: 28,
        w: 1320,
        h: 922,
        paper: "cream",
        edge: "torn",
        torn: [2],
        tilt: -0.3,
      });
      c.add(
        `<g transform="rotate(-0.3 700 489)">${ruledLines(c, 40, 28, 1320, 922, { gap: 42, inset: 24, top: 66, opacity: 0.6 }).join("")}</g>`,
      );
      c.add(marginLine(c, 82, 42, 890));
      tape(c, { x: 150, y: 18, w: 125, h: 30, angle: -3 });
      tape(c, { x: 1120, y: 18, w: 125, h: 30, angle: 3 });
    },
  },
  {
    name: "notice_strip",
    dir: "hud",
    width: 1100,
    height: 80,
    textBox: [40, 16, 1020, 48],
    slice: [16, 36, 16, 36],
    note: "Advance-block message. Keep fixed height; stretch only the horizontal centre band.",
    draw(c) {
      paperPiece(c, {
        x: 16,
        y: 12,
        w: 1066,
        h: 56,
        paper: "yellow",
        shadow: { dx: 1, dy: 2, blur: 1.5, opacity: 0.2 },
      });
    },
  },
  ...["error", "info"].map((kind) => ({
    name: `toast_${kind}`,
    dir: "hud",
    width: 900,
    height: 120,
    seed: "hud_toast",
    textBox: [44, 26, 700, 68],
    slice: [50, 150, 24, 40],
    note: "Reserve x=750..900 for the runtime close button; paper there is undecorated. Stretch horizontally.",
    draw: (c) => toast(c, kind === "error"),
  })),
  {
    name: "end_card",
    dir: "hud",
    width: 520,
    height: 360,
    textBox: [48, 48, 424, 180],
    note: "Place a runtime 360x64 button at [80,260]; no lettering or button is baked in.",
    draw(c) {
      paperPiece(c, {
        x: 22,
        y: 22,
        w: 474,
        h: 310,
        paper: "light",
        fold: "br",
        foldSize: 22,
      });
      highlight(c, { x: 62, y: 239, w: 160, h: 10, opacity: 0.4, angle: -1 });
      tape(c, { x: 201, y: 14, w: 100, h: 24, angle: -2 });
    },
  },
  ...Object.entries(iconDrawings).map(([name, draw]) => ({
    name: `tool_${name}`,
    dir: "hud",
    width: 72,
    height: 72,
    note: "Transparent graphite icon; overlay on tool_back_hover or tool_back_active at the same origin.",
    draw(c) {
      const p = iconPen(c);
      draw(p);
      c.add(p.flush());
    },
  })),
  {
    name: "tool_back_hover",
    dir: "hud",
    width: 72,
    height: 72,
    seed: "hud_tool_back",
    draw(c) {
      highlight(c, { x: 10, y: 18, w: 52, h: 37, opacity: 0.6, angle: -3 });
    },
  },
  {
    name: "tool_back_active",
    dir: "hud",
    width: 72,
    height: 72,
    seed: "hud_tool_back",
    draw(c) {
      const p = new Pen(c, {
        color: PALETTE.blue,
        width: 2.8,
        wobble: 0.6,
        jitter: 0.4,
        overshoot: 0,
      });
      circleScribble(p, 36, 36, 26, 25);
      c.add(p.flush());
    },
  },
  {
    name: "scratch_paper",
    dir: "hud",
    width: 480,
    height: 360,
    slice: [50, 60, 50, 60],
    note: "Blank overlay scrap; keep labels within [50,50,380,260]. Stretchable with fixed corner folds.",
    draw(c) {
      paperPiece(c, {
        x: 22,
        y: 22,
        w: 434,
        h: 312,
        paper: "light",
        fold: "tr",
        foldSize: 26,
      });
      shade(
        c,
        [
          [28, 303],
          [45, 317],
          [28, 321],
        ],
        { width: 1.4, gap: 4, opacity: 0.3 },
      );
    },
  },
];
