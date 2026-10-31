import { PALETTE } from "../canvas.mjs";
import {
  highlight,
  paperPiece,
  tape,
  cornerMarks,
  ruledLines,
} from "../parts.mjs";
import { Pen } from "../pencil.mjs";

function saveSlot(c, state) {
  paperPiece(c, {
    x: 12,
    y: 12,
    w: 603,
    h: 176,
    paper: "light",
    shadow: {
      dx: 1,
      dy: state === "hover" ? 3 : 2,
      blur: state === "hover" ? 3 : 2,
      opacity: 0.22,
    },
    outline: { color: PALETTE.graphiteMid, width: 2.7, opacity: 0.7 },
  });
  const pen = new Pen(c, {
    width: 1.8,
    opacity: 0.6,
    overshoot: 0,
    wobble: 0.6,
  });
  pen.rect(18, 18, 240, 135, {
    crossing: 0,
    color: PALETTE.paperEdge,
    opacity: 0.65,
  });
  cornerMarks(pen, 21, 21, 234, 129, 14, { width: 2.6 });
  pen.line(269, 27, 269, 168, {
    color: PALETTE.paperEdge,
    width: 1.4,
    opacity: 0.5,
  });
  pen.line(34, 171, 243, 171, {
    color: PALETTE.ruleBlue,
    width: 1.4,
    opacity: 0.5,
  });
  c.add(pen.flush());
  tape(c, { x: 24, y: 15, w: 37, h: 10, angle: -3, opacity: 0.65 });
  tape(c, { x: 216, y: 145, w: 37, h: 10, angle: 3, opacity: 0.65 });
  if (state === "hover") {
    highlight(c, { x: 283, y: 183, w: 307, h: 5, opacity: 0.65 });
    const mark = new Pen(c, { color: PALETTE.blue, width: 2.8, overshoot: 0 });
    mark.line(16, 163, 16, 180);
    mark.line(16, 180, 29, 180);
    c.add(mark.flush());
  }
  if (state === "empty") {
    const mark = new Pen(c, {
      color: PALETTE.graphiteLight,
      width: 1.4,
      opacity: 0.5,
      passes: 1,
    });
    mark.rect(108, 54, 62, 46, { r: 2, opacity: 0.35, overshoot: 0 });
    mark.line(139, 65, 139, 89, { width: 2, opacity: 0.6 });
    mark.line(127, 77, 151, 77, { width: 2, opacity: 0.6 });
    for (let x = 30; x < 246; x += 18) mark.line(x, 164, x + 8, 164);
    c.add(mark.flush());
  }
}

export const assets = [
  {
    name: "modal_backdrop",
    dir: "panel",
    width: 1920,
    height: 1080,
    note: "Warm grey dim: centre alpha .48, edges up to .60. Composite over the running game.",
    draw(c) {
      const id = c.id("vignette");
      c.def(
        `<radialGradient id="${id}" cx="50%" cy="46%" r="72%"><stop offset="0.4" stop-color="${PALETTE.graphiteMid}" stop-opacity="0"/><stop offset="1" stop-color="${PALETTE.graphite}" stop-opacity="0.24"/></radialGradient>`,
      );
      c.add(
        `<rect width="1920" height="1080" fill="${PALETTE.graphiteMid}" opacity="0.48"/><rect width="1920" height="1080" fill="url(#${id})"/>`,
      );
    },
  },
  {
    name: "modal_panel",
    dir: "panel",
    width: 1380,
    height: 900,
    textBox: [54, 46, 1272, 808],
    slice: [44, 44, 44, 50],
    note: "Plain notebook interior. Binding holes stay in corner slices; rules are deliberately faint.",
    draw(c) {
      paperPiece(c, {
        x: 20,
        y: 20,
        w: 1336,
        h: 856,
        paper: "cream",
        shadow: { dx: 2, dy: 4, blur: 4, opacity: 0.28 },
      });
      c.add(
        ...ruledLines(c, 22, 22, 1332, 850, {
          gap: 40,
          inset: 28,
          top: 64,
          opacity: 0.35,
          width: 1.2,
        }),
      );
      const pen = new Pen(c, { width: 1.8, opacity: 0.6 });
      for (const y of [35, 865]) {
        pen.ellipse(36, y, 5, 4, { width: 2.5 });
        pen.ellipse(35, y - 2, 12, 7, { color: PALETTE.graphiteMid });
      }
      c.add(pen.flush());
    },
  },
  {
    name: "panel_title_tab",
    dir: "panel",
    width: 360,
    height: 84,
    textBox: [32, 24, 296, 36],
    slice: [24, 80, 24, 80],
    note: "Heading centred in the chosen textBox; tape stays in top corners.",
    draw(c) {
      paperPiece(c, {
        x: 16,
        y: 16,
        w: 328,
        h: 52,
        paper: "light",
        shadow: { dx: 1, dy: 2, blur: 2, opacity: 0.22 },
      });
      tape(c, { x: 24, y: 12, w: 44, h: 10, angle: -2 });
      tape(c, { x: 292, y: 12, w: 44, h: 10, angle: 2 });
    },
  },
  ...["normal", "hover", "empty"].map((state) => ({
    name: `save_slot_${state}`,
    dir: "panel",
    width: 627,
    height: 200,
    seed: "save_slot",
    textBox: [278, 18, 331, 164],
    slice: [18, 18, 30, 274],
    note: "Thumbnail at [18,18,240,135]; use empty_thumbnail for empty state. Thumbnail and photo corners remain in left slice.",
    draw(c) {
      saveSlot(c, state);
    },
  })),
  {
    name: "empty_thumbnail",
    dir: "panel",
    width: 240,
    height: 135,
    note: "Inset placeholder photo; composite in save-slot thumbnail window.",
    draw(c) {
      paperPiece(c, {
        x: 12,
        y: 12,
        w: 216,
        h: 111,
        paper: "grey",
        outline: { color: PALETTE.graphiteLight, width: 1.8, opacity: 0.45 },
        shadow: false,
      });
      const pen = new Pen(c, {
        color: PALETTE.graphiteLight,
        width: 1.8,
        opacity: 0.55,
        passes: 1,
      });
      pen.polyline([
        [46, 98],
        [87, 55],
        [124, 88],
        [151, 66],
        [194, 99],
      ]);
      pen.line(46, 100, 195, 100);
      pen.ellipse(164, 42, 10, 10);
      pen.line(57, 109, 190, 28, { opacity: 0.25, width: 1.3 });
      c.add(pen.flush());
    },
  },
  {
    name: "history_rule",
    dir: "panel",
    width: 1272,
    height: 28,
    slice: [0, 32, 0, 32],
    note: "Transparent divider; horizontal stretch only.",
    draw(c) {
      const pen = new Pen(c, {
        width: 2.8,
        color: PALETTE.graphite,
        opacity: 0.75,
        passes: 2,
        overshoot: 0,
      });
      pen.line(34, 14, 1254, 14);
      pen.path(
        [
          [16, 13],
          [21, 18],
          [29, 8],
        ],
        { width: 2.5 },
      );
      pen.line(1247, 10, 1252, 18);
      c.add(pen.flush());
    },
  },
  {
    name: "settings_row",
    dir: "panel",
    width: 1272,
    height: 76,
    slice: [14, 24, 14, 24],
    note: "Faint light-paper row, all content remains UI text/controls.",
    draw(c) {
      paperPiece(c, {
        x: 14,
        y: 12,
        w: 1244,
        h: 50,
        paper: "light",
        shadow: false,
        outline: false,
      });
      const pen = new Pen(c, {
        color: PALETTE.ruleBlue,
        width: 1.3,
        opacity: 0.4,
        passes: 1,
        overshoot: 0,
      });
      pen.line(25, 62, 1247, 62);
      c.add(pen.flush());
    },
  },
];
