import { PALETTE } from "../canvas.mjs";
import { letters } from "../font.mjs";
import {
  checkMark,
  crossMark,
  ellipsePoints,
  gridLines,
  highlight,
  paperPiece,
  shade,
  tape,
  wash,
} from "../parts.mjs";
import { Pen } from "../pencil.mjs";

const states = ["normal", "hover", "pressed", "disabled"];
const compactNote =
  "Compact inventory textBox requires less than 12px paper clearance; tight shadows stay inside the canvas.";

function pencil(c, options = {}) {
  return new Pen(c, {
    width: 3,
    wobble: 0.7,
    jitter: 0.6,
    overshoot: 1,
    ...options,
  });
}

// Only appearance changes between states; every base consumes identical RNG calls.
function cardBase(c, family, state) {
  const choice = family.startsWith("choice");
  const secondary = family === "choice_secondary";
  const title = family === "title_button";
  const disabled = state === "disabled";
  const pressed = state === "pressed";
  const x = choice ? 14 : 12;
  const y = choice ? 12 : 6;
  const w = c.w - x * 2;
  const h = c.h - y * 2;
  const shadow = {
    dx: pressed ? 0 : 1,
    dy: pressed ? 1 : 2,
    blur: state === "hover" ? (choice ? 3 : 1.6) : 1,
    opacity: state === "hover" ? 0.34 : 0.2,
  };
  const paper = disabled ? "grey" : pressed ? "cream" : "light";
  const { poly } = paperPiece(c, {
    x,
    y,
    w,
    h,
    paper: secondary && !disabled ? "kraft" : paper,
    edge: title ? "torn" : "cut",
    torn: [2],
    tornAmp: 1.5,
    shadow,
    outline: {
      color: PALETTE.graphite,
      width: 2.8,
      opacity: disabled ? 0.4 : 0.86,
    },
    rules: choice && !secondary ? "ruled" : null,
    ruleGap: 30,
    ruleInset: 20,
  });
  if (secondary) {
    // A cream writing field keeps navy labels readable against the kraft rim.
    c.add(
      c.layer(
        `<rect x="29" y="14" width="922" height="64" fill="${disabled ? "#dcdad2" : pressed ? PALETTE.paper : PALETTE.paperLight}"/>`,
        { box: { x0: 29, y0: 14, x1: 951, y1: 78 }, kind: "fiber", pad: 0 },
      ),
    );
    c.add(
      ...gridLines(c, 30, 14, 920, 64, {
        gap: 16,
        opacity: disabled ? 0.2 : 0.35,
        width: 1.2,
      }),
    );
    const seam = pencil(c, {
      width: 1.5,
      color: PALETTE.graphiteMid,
      opacity: disabled ? 0.4 : 0.65,
      passes: 1,
    });
    seam.line(24, 23, 24, 68);
    seam.line(c.w - 24, 23, c.w - 24, 68);
    c.add(seam.flush());
  }
  if (choice && !secondary) {
    // The tape is confined to the narrow margin, outside the optional icon.
    tape(c, {
      x: 16,
      y: 29,
      w: 11,
      h: 30,
      angle: -2,
      color: disabled ? PALETTE.graphiteFaint : PALETTE.paperDark,
      opacity: 0.7,
    });
  }
  return { x, y, w, h, poly };
}

function cardState(c, family, state, box) {
  const choice = family.startsWith("choice");
  const { x, y, w, h } = box;
  if (state === "hover") {
    // State marks never enter a label rectangle.
    highlight(c, {
      x: x + 10,
      y: y + h + (choice ? 2 : 1),
      w: w - 20,
      h: choice ? 5 : 3,
      opacity: 1,
    });
    highlight(c, {
      x: choice ? x + 3 : 3,
      y: y + 8,
      w: choice ? 11 : 6,
      h: h - 16,
      opacity: 1,
    });
    const pen = pencil(c, { color: PALETTE.yellow, width: 3.5 });
    pen.line(x + 5, y + 8, x + 5, y + h - 8);
    c.add(pen.flush());
  }
  if (state === "pressed") {
    const pen = pencil(c, { color: PALETTE.ink, width: 3.2 });
    pen.line(x + 15, y + h - 1, x + w - 15, y + h - 1);
    pen.line(x + 5, y + 8, x + 5, y + h - 8);
    c.add(pen.flush());
  }
}

function cardFamily(name, width, height, textBox, extra = {}) {
  return states.map((state) => ({
    name: `${name}_${state}`,
    dir: "menu",
    width,
    height,
    seed: name,
    textBox,
    ...extra,
    draw(c) {
      const start = c.body.length;
      const box = cardBase(c, name, state);
      cardState(c, name, state, box);
      if (state === "pressed") {
        const body = c.body.splice(start).join("");
        c.add(`<g transform="translate(0 2)">${body}</g>`);
      }
    },
  }));
}

function icon(c, name) {
  const pen = pencil(c, { width: 3.5, passes: 2 });
  if (name === "lemma") {
    letters(pen, "∑", 16, 43, 31, { tilt: 0, drift: 0 });
    pen.line(13, 48, 43, 48, { width: 1.5, opacity: 0.6 });
  } else if (name === "question") {
    letters(pen, "?", 16, 44, 34, { tilt: 0, drift: 0 });
  } else if (name === "warning") {
    const triangle = [
      [28, 8],
      [48, 45],
      [8, 45],
    ];
    wash(c, triangle, PALETTE.yellow, { opacity: 0.32 });
    pen.polyline([...triangle, triangle[0]], { width: 2.8 });
    letters(pen, "!", 20.5, 39, 23, { tilt: 0, drift: 0 });
  } else if (name === "lock") {
    pen.path([
      [18, 26],
      [18, 18],
      [21, 12],
      [28, 10],
      [35, 13],
      [38, 19],
      [38, 26],
    ]);
    pen.rect(13, 26, 30, 22, { r: 3 });
    pen.dot(28, 34, 2.2);
    pen.line(28, 35, 28, 41, { width: 2.3 });
  } else if (name === "star") {
    const points = Array.from({ length: 10 }, (_, i) => {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const radius = i % 2 === 0 ? 20 : 9;
      return [28 + Math.cos(angle) * radius, 29 + Math.sin(angle) * radius];
    });
    wash(c, points, PALETTE.yellow, { opacity: 0.4 });
    pen.polyline([...points, points[0]], { width: 3, overshoot: 0 });
  } else {
    checkMark(pen, 28, 28, 36, { color: PALETTE.green, width: 4.2 });
  }
  c.add(pen.flush());
}

function checkboxBase(c) {
  paperPiece(c, {
    x: 10,
    y: 10,
    w: 24,
    h: 24,
    paper: "light",
    edge: "cut",
    shadow: { dx: 1, dy: 1, blur: 1, opacity: 0.2 },
  });
}

function closeBase(c) {
  wash(c, ellipsePoints(28, 28, 17, 17), PALETTE.paperLight, { opacity: 0.9 });
  const pen = pencil(c, { width: 3.2 });
  crossMark(pen, 28, 28, 21);
  c.add(pen.flush());
}

function trackBase(c) {
  const poly = ellipseTrack();
  wash(c, poly, PALETTE.paperDark, { opacity: 0.7 });
  const pen = pencil(c, { width: 1.8, opacity: 0.65 });
  pen.outline(poly);
  c.add(pen.flush());
  return poly;
}

// Narrow capsule geometry shared by the track and its coloured fill overlay.
function ellipseTrack() {
  return [
    [15, 12],
    [405, 12],
    [409, 16],
    [405, 20],
    [15, 20],
    [11, 16],
  ];
}

function tabBase(c) {
  paperPiece(c, {
    x: 12,
    y: 7,
    w: 196,
    h: 46,
    paper: "light",
    edge: "round",
    r: 7,
    shadow: { dx: 1, dy: 2, blur: 1, opacity: 0.2 },
  });
}

export const assets = [
  ...cardFamily("choice_primary", 980, 92, [32, 14, 916, 64], {
    note: "Ruled reference family. Optional 56px icon at x=32; label starts at x=106. Pressed paper moves down 2px.",
  }),
  ...cardFamily("choice_secondary", 980, 92, [32, 14, 916, 64], {
    note: "Kraft rim with a light writing field; same icon and label placement as primary.",
  }),
  ...["lemma", "question", "warning", "lock", "star", "check"].map((name) => ({
    name: `choice_icon_${name}`,
    dir: "menu",
    width: 56,
    height: 56,
    draw: (c) => icon(c, name),
  })),
  ...cardFamily("button", 360, 64, [24, 10, 312, 44], {
    slice: [9, 24, 9, 24],
    note: `Centred label; stretch the quiet middle bands. ${compactNote}`,
  }),
  ...cardFamily("title_button", 482, 60, [20, 8, 442, 44], {
    note: `Left-aligned label; torn index-card strip. ${compactNote}`,
  }),
  ...["normal", "hover"].map((state) => ({
    name: `close_${state}`,
    dir: "menu",
    width: 56,
    height: 56,
    seed: "close",
    draw(c) {
      closeBase(c);
      if (state === "hover") {
        const pen = pencil(c, { color: PALETTE.yellow, width: 4 });
        pen.ellipse(28, 28, 20, 20);
        c.add(pen.flush());
      }
    },
  })),
  ...["off", "on"].map((state) => ({
    name: `checkbox_${state}`,
    dir: "menu",
    width: 44,
    height: 44,
    seed: "checkbox",
    draw(c) {
      checkboxBase(c);
      if (state === "on") {
        const pen = pencil(c, { color: PALETTE.ink, width: 3.3 });
        checkMark(pen, 23, 21, 23);
        c.add(pen.flush());
      }
    },
  })),
  ...["track", "fill"].map((part) => ({
    name: `slider_${part}`,
    dir: "menu",
    width: 420,
    height: 32,
    seed: "slider",
    note: "Track centre y=16; clip the full-width fill from the left to the current value, without rescaling it.",
    draw(c) {
      const poly = trackBase(c);
      if (part === "fill") {
        wash(c, poly, PALETTE.blue, { opacity: 0.8 });
        shade(c, poly, {
          color: PALETTE.blue,
          width: 1.4,
          gap: 5,
          opacity: 0.6,
        });
      }
    },
  })),
  {
    name: "slider_knob",
    dir: "menu",
    width: 40,
    height: 40,
    note: "Centre at (20,20); place over the slider track centre.",
    draw(c) {
      const poly = ellipsePoints(20, 20, 12, 12);
      c.add(
        `<path d="M8 20a12 12 0 1 0 24 0a12 12 0 1 0 -24 0" fill="${PALETTE.paperWhite}"/>`,
      );
      wash(c, poly, PALETTE.paperLight, { opacity: 0.5 });
      const pen = pencil(c, { width: 2.7 });
      pen.ellipse(20, 20, 12, 12);
      pen.line(18, 16, 18, 24, { width: 1.5, color: PALETTE.blue });
      pen.line(22, 16, 22, 24, { width: 1.5, color: PALETTE.blue });
      c.add(pen.flush());
    },
  },
  {
    name: "select_box",
    dir: "menu",
    width: 320,
    height: 56,
    textBox: [18, 8, 250, 40],
    note: `Arrow lies outside the label area. ${compactNote}`,
    draw(c) {
      paperPiece(c, {
        x: 10,
        y: 6,
        w: 300,
        h: 44,
        paper: "light",
        shadow: { dx: 1, dy: 1, blur: 1, opacity: 0.2 },
      });
      const pen = pencil(c, { width: 2.8 });
      pen.line(278, 15, 278, 41, { width: 1.4, color: PALETTE.graphiteFaint });
      pen.polyline([
        [286, 25],
        [293, 32],
        [300, 25],
      ]);
      c.add(pen.flush());
    },
  },
  ...["normal", "active"].map((state) => ({
    name: `tab_${state}`,
    dir: "menu",
    width: 220,
    height: 60,
    seed: "tab",
    textBox: [20, 10, 180, 40],
    note: compactNote,
    draw(c) {
      tabBase(c);
      if (state === "active") {
        highlight(c, {
          x: 14,
          y: 14,
          w: 4,
          h: 32,
          color: PALETTE.blue,
          opacity: 0.8,
        });
        const pen = pencil(c, { color: PALETTE.blue, width: 4.5 });
        pen.line(25, 54, 195, 54);
        pen.line(16, 16, 16, 44);
        c.add(pen.flush());
      }
    },
  })),
];
