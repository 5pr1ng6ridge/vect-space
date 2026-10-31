import { PALETTE } from "../canvas.mjs";
import { letters, measureLetters } from "../font.mjs";
import {
  checkMark,
  cornerMarks,
  crossMark,
  gridLines,
  highlight,
  paperPiece,
  pathOf,
  tape,
  wash,
} from "../parts.mjs";
import { ellipsePoints, Pen } from "../pencil.mjs";

const tightShadow = { dx: 1, dy: 1, blur: 1.2, opacity: 0.18 };
const outline = { color: PALETTE.graphite, width: 2.8, opacity: 0.8 };
const rect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

function asset(name, width, height, draw, options = {}) {
  return { name, dir: "proof", width, height, draw, ...options };
}

// Compact UI contracts leave less than 12px around their text boxes. These
// scraps use a tight shadow and no tilt, keeping the entire label on paper.
function compactPaper(c, { paper = "light", hover = false } = {}) {
  paperPiece(c, {
    x: 5,
    y: 5,
    w: c.w - 12,
    h: c.h - 12,
    paper,
    outline: { ...outline, opacity: paper === "grey" ? 0.36 : 0.8 },
    shadow: hover ? { dx: 1, dy: 2, blur: 1.7, opacity: 0.26 } : tightShadow,
  });
}

function background(c) {
  c.add(`<rect width="1920" height="1080" fill="${PALETTE.kraftDark}"/>`);
  paperPiece(c, {
    x: 18,
    y: 18,
    w: 1882,
    h: 1042,
    paper: "light",
    outline: { ...outline, opacity: 0.55 },
    shadow: { dx: 3, dy: 4, blur: 4, opacity: 0.28 },
  });
  c.add(
    ...gridLines(c, 302, 152, 1316, 898, {
      gap: 32,
      color: PALETTE.gridBlue,
      opacity: 0.4,
      width: 1.3,
      major: 5,
    }),
  );
  for (const [x, y, w, h, paper] of [
    [24, 151, 274, 901, "cream"],
    [1622, 151, 272, 901, "blue"],
  ]) {
    paperPiece(c, { x, y, w, h, paper, outline: false, shadow: false });
  }
  paperPiece(c, {
    x: 16,
    y: 14,
    w: 1886,
    h: 130,
    paper: "cream",
    outline: { ...outline, width: 2.2, opacity: 0.6 },
    shadow: { dx: 1, dy: 3, blur: 2, opacity: 0.22 },
  });
  // Tape sits above the header's [30,25,1860,100] UI text box.
  tape(c, { x: 48, y: 7, w: 114, h: 15, angle: -1 });
  tape(c, { x: 1752, y: 7, w: 114, h: 15, angle: 1 });
  const pen = new Pen(c, { width: 1.7, opacity: 0.4, passes: 1 });
  pen.line(300, 166, 300, 1044);
  pen.line(1620, 166, 1620, 1044);
  // Scratch work stays in outer gutters and below the header label box.
  // One pen batches all marks, including the partly erased calculation.
  letters(pen, "∑ →", 42, 139, 10, { drift: 0.02, width: 1.6 });
  letters(pen, "∫", 1868, 139, 10, { drift: 0.02, width: 1.6 });
  letters(pen, "∑", 29, 260, 22, { width: 2.3, opacity: 0.55 });
  pen.line(28, 270, 45, 270);
  letters(pen, "∫", 1875, 670, 23, { width: 2.3, opacity: 0.55 });
  letters(pen, "?", 1875, 721, 17, { width: 2.1, opacity: 0.65 });
  pen.ellipse(1881, 713, 12, 15, { width: 1.7, opacity: 0.5 });
  letters(pen, "1 + 1 = 2", 46, 1045, 17, { opacity: 0.23 });
  pen.line(43, 1038, 173, 1042, { opacity: 0.25, width: 2.3 });
  pen.path(
    [
      [1836, 1028],
      [1851, 1032],
      [1873, 1023],
    ],
    { opacity: 0.55 },
  );
  pen.line(1873, 1023, 1863, 1022, { opacity: 0.55 });
  pen.line(1873, 1023, 1868, 1032, { opacity: 0.55 });
  c.add(pen.flush());
  wash(
    c,
    [
      [38, 1033],
      [83, 1029],
      [164, 1036],
      [170, 1046],
      [75, 1048],
      [40, 1042],
    ],
    PALETTE.graphiteLight,
    { opacity: 0.1 },
  );
}

function panel(c, right) {
  paperPiece(c, {
    x: 14,
    y: 14,
    w: 270,
    h: 900,
    paper: right ? "light" : "cream",
    outline,
    shadow: { dx: 2, dy: 3, blur: 3, opacity: 0.22 },
  });
  tape(c, { x: 27, y: 17, w: 40, h: 23, angle: -2 });
  tape(c, { x: 232, y: 17, w: 40, h: 23, angle: 2 });
  const pen = new Pen(c, { width: 1.7, opacity: 0.5 });
  pen.line(29, 895, 56, 895);
  pen.line(29, 900, 48, 900);
  c.add(pen.flush());
}

function paletteCard(c, state) {
  compactPaper(c, {
    paper: state === "disabled" ? "grey" : "light",
    hover: state === "hover",
  });
  if (state === "hover") {
    highlight(c, { x: 17, y: 87, w: 230, h: 4, opacity: 0.85 });
    const pen = new Pen(c, {
      color: PALETTE.yellow,
      width: 3.4,
      overshoot: 0,
      jitter: 0.2,
    });
    pen.line(8, 20, 8, 76);
    c.add(pen.flush());
  }
}

function node(c, state) {
  compactPaper(c);
  wash(c, rect(8, 7, 282, 39), PALETTE.gridBlue, { opacity: 0.16 });
  const rule = new Pen(c, { width: 1.6, opacity: 0.48, passes: 1 });
  rule.line(12, 48, 286, 48);
  c.add(rule.flush());
  if (state === "normal") return;
  const color = {
    selected: PALETTE.blue,
    error: PALETTE.red,
    complete: PALETTE.green,
  }[state];
  const pen = new Pen(c, {
    color,
    width: 2.8,
    opacity: 0.9,
    overshoot: 0.5,
    jitter: 0.4,
  });
  if (state === "selected") {
    cornerMarks(pen, 10, 6, 280, 224, 11, { width: 3.4, passes: 2 });
    pen.line(10, 58, 10, 211, { width: 3.4 });
    pen.line(290, 58, 290, 211, { width: 3.4 });
  } else if (state === "error") {
    crossMark(pen, 282, 223, 10, { width: 2.3 });
    pen.line(9, 58, 9, 211);
  } else {
    checkMark(pen, 282, 223, 12, { width: 2.5 });
  }
  c.add(pen.flush());
}

const categories = {
  premise: ["blue", PALETTE.blue],
  rule: ["cream", PALETTE.orange],
  conclusion: ["green", PALETTE.green],
  lemma: ["light", PALETTE.purple],
};

function nodeHeader(c, category) {
  const [paper, color] = categories[category];
  paperPiece(c, {
    x: 5,
    y: 5,
    w: 288,
    h: 40,
    paper,
    outline: { ...outline, width: 1.8, opacity: 0.5 },
    shadow: false,
  });
  wash(c, rect(8, 7, 282, 34), color, {
    opacity: category === "lemma" ? 0.3 : 0.14,
  });
  // The bottom stripe leaves the node's [16, 8, 268, 32] label box clear.
  highlight(c, { x: 13, y: 43, w: 274, h: 3, color, opacity: 0.55 });
}

function port(c, state) {
  // The paper disc keeps sockets readable over wires and the graph paper.
  c.add(`<circle cx="14" cy="14" r="9.6" fill="${PALETTE.paperWhite}"/>`);
  const pen = new Pen(c, {
    color: state === "mismatch" ? PALETTE.red : PALETTE.graphite,
    width: 2.3,
    wobble: 0.35,
    jitter: 0.22,
    overshoot: 0,
    step: 2,
    opacity: 0.95,
  });
  if (state === "local") {
    for (let i = 0; i < 6; i += 1) {
      pen.stroke(
        ellipsePoints(14, 14, 9.3, 9.3, 1, (i * Math.PI) / 3, Math.PI / 5),
        {
          width: 2.8,
          passes: 2,
          taper: 0.95,
          jitter: 0.08,
          wobble: 0.1,
        },
      );
    }
  } else {
    pen.ellipse(14, 14, 9.3, 9.3);
  }
  if (state === "connected") {
    pen.scribble(rect(9, 9, 10, 10), {
      gap: 1.5,
      width: 2.5,
      color: PALETTE.ink,
    });
  }
  if (state === "mismatch") crossMark(pen, 14, 14, 8, { width: 2.1 });
  c.add(pen.flush());
}

function status(c, state) {
  compactPaper(c, { paper: state === "unavailable" ? "grey" : "light" });
  const color = {
    complete: PALETTE.green,
    incomplete: PALETTE.orange,
    unavailable: PALETTE.graphiteMid,
  }[state];
  const pen = new Pen(c, {
    color,
    width: 2,
    jitter: 0.3,
    overshoot: 0,
    opacity: 0.8,
  });
  pen.line(13, 7, 226, 7);
  pen.line(13, 57, 226, 57);
  pen.line(9, 14, 9, 49);
  pen.line(230, 14, 230, 49);
  c.add(pen.flush());
}

function qed(c) {
  const pen = new Pen(c, {
    color: PALETTE.ink,
    width: 3.4,
    passes: 2,
    opacity: 0.9,
    wobble: 0.7,
    overshoot: 0,
  });
  pen.ellipse(120, 120, 94, 94);
  pen.ellipse(120, 120, 84, 84, { width: 1.8, opacity: 0.65 });
  const size = 52;
  letters(
    pen,
    "QED",
    (240 - measureLetters("QED", size, 0.65)) / 2,
    115,
    size,
    {
      spacing: 0.65,
      tilt: 1.5,
      drift: 0.025,
      width: 5.8,
    },
  );
  pen.line(65, 130, 175, 130, { width: 1.8, opacity: 0.65 });
  const square = rect(106, 148, 28, 28);
  // The font has no ∎: a filled, tooth-filtered square makes the end mark.
  const ink = c.layer(
    `<path d="${pathOf(square)}" fill="${PALETTE.ink}" fill-opacity="0.9"/>`,
    {
      kind: "pencil",
      box: { x0: 104, y0: 146, x1: 136, y1: 178 },
    },
  );
  c.add(`<g transform="rotate(-3 120 120)">${pen.flush()}${ink}</g>`);
}

export const assets = [
  asset("proof_background", 1920, 1080, background, {
    note: "Opaque desk sheet. Header y<150; palette x<300; diagnostics x>1620. Calm 32px grid in the working canvas.",
  }),
  asset(
    "proof_header",
    1920,
    150,
    (c) => {
      paperPiece(c, {
        x: 15,
        y: 14,
        w: 1888,
        h: 120,
        paper: "cream",
        outline,
        shadow: tightShadow,
      });
      const pen = new Pen(c, { width: 1.5, opacity: 0.4 });
      pen.line(33, 130, 1885, 130);
      c.add(pen.flush());
    },
    { textBox: [30, 25, 1860, 100] },
  ),
  ...["left", "right"].map((side) =>
    asset(`proof_panel_${side}`, 300, 930, (c) => panel(c, side === "right"), {
      seed: "proof_panel",
      slice: [68, 76, 42, 76],
      note: "Stretch the blank middle vertically; tape stays in top corners. Suggested content inset 28px.",
    }),
  ),
  ...["normal", "hover", "disabled"].map((state) =>
    asset(
      `proof_palette_card_${state}`,
      264,
      96,
      (c) => paletteCard(c, state),
      {
        seed: "proof_palette_card",
        textBox: [12, 12, 240, 72],
        note: "Compact shadow preserves the inventory text box; label and rule description are rendered by UI.",
      },
    ),
  ),
  ...["normal", "selected", "error", "complete"].map((state) =>
    asset(`proof_node_${state}`, 300, 240, (c) => node(c, state), {
      seed: "proof_node",
      textBox: [16, 8, 268, 32],
      slice: [56, 24, 24, 24],
      note: "Header fixed through y=48; stretch body vertically. Bottom-right 24px corner reserved for state mark. Ports are separate 28px overlays.",
    }),
  ),
  ...Object.keys(categories).map((category) =>
    asset(
      `proof_node_header_${category}`,
      300,
      52,
      (c) => nodeHeader(c, category),
      {
        seed: "proof_node_header",
        note: "Overlay at node origin beneath its UI label; category accent sits below label y=40.",
      },
    ),
  ),
  ...["open", "connected", "mismatch", "local"].map((state) =>
    asset(`proof_port_${state}`, 28, 28, (c) => port(c, state), {
      seed: "proof_port",
      note: "Socket centre [14,14], ring radius 9.3px; no paper shadow on this small icon.",
    }),
  ),
  ...["complete", "incomplete", "unavailable"].map((state) =>
    asset(`proof_status_${state}`, 240, 64, (c) => status(c, state), {
      seed: "proof_status",
      textBox: [16, 10, 208, 44],
      note: "Status lettering supplied by UI. Border ink carries status; keep label centred.",
    }),
  ),
  asset(
    "proof_goal_plate",
    820,
    88,
    (c) => {
      compactPaper(c);
      const pen = new Pen(c, {
        color: PALETTE.blue,
        width: 2.6,
        opacity: 0.7,
        overshoot: 0,
      });
      pen.polyline([
        [18, 15],
        [12, 15],
        [12, 72],
        [18, 72],
      ]);
      pen.polyline([
        [800, 15],
        [806, 15],
        [806, 72],
        [800, 72],
      ]);
      c.add(pen.flush());
    },
    {
      textBox: [24, 14, 772, 60],
      note: "KaTeX goal formula stays on unruled light paper between blue brackets.",
    },
  ),
  asset("proof_qed_stamp", 240, 240, qed, {
    note: "Transparent ink-blue QED seal with filled ∎; rotated -3 degrees within the image.",
  }),
  asset(
    "proof_canvas_controls",
    1296,
    64,
    (c) => {
      paperPiece(c, {
        x: 14,
        y: 12,
        w: 1266,
        h: 38,
        paper: "cream",
        outline: { ...outline, width: 2 },
        shadow: tightShadow,
      });
      const pen = new Pen(c, { width: 1.6, opacity: 0.55 });
      for (const x of [27, 1258]) {
        for (let i = 0; i < 3; i += 1) pen.line(x + i * 4, 25, x + i * 4, 37);
      }
      c.add(pen.flush());
    },
    {
      slice: [22, 50, 22, 50],
      note: "Horizontal stretch only. UI controls occupy x=52..1244, y=18..44; grip marks stay in end caps.",
    },
  ),
];
