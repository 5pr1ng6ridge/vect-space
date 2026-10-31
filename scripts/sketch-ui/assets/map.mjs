import { PALETTE } from "../canvas.mjs";
import {
  paperPiece,
  gridLines,
  checkMark,
  highlight,
  pathOf,
  tape,
  wash,
  arrow,
} from "../parts.mjs";
import { Pen, ellipsePoints, smooth } from "../pencil.mjs";

// Dash sampled curves with pencil strokes, preserving a hand-drawn route.
function trail(pen, points) {
  const samples = smooth(points, 4);
  for (let i = 0; i + 1 < samples.length; i += 9) {
    pen.stroke(samples.slice(i, i + 5), {
      width: 3.5,
      opacity: 0.75,
      overshoot: 0,
    });
  }
}

function background(c) {
  c.add(`<rect width="1920" height="1080" fill="${PALETTE.paper}"/>`);
  paperPiece(c, {
    x: 24,
    y: 24,
    w: 1872,
    h: 1032,
    paper: "light",
    outline: { color: PALETTE.paperEdge, width: 2.8, opacity: 0.5 },
    shadow: false,
  });
  for (const [x, y, rx, ry, color] of [
    [340, 295, 235, 155, PALETTE.highlightGreen],
    [1030, 840, 255, 130, PALETTE.highlightBlue],
    [1470, 330, 210, 155, PALETTE.highlightYellow],
  ])
    wash(c, ellipsePoints(x, y, rx, ry, 18), color, { opacity: 0.24 });
  c.add(
    ...gridLines(c, 28, 28, 1864, 1024, {
      gap: 32,
      opacity: 0.4,
      width: 1.2,
      major: 5,
    }),
  );
  const pen = new Pen(c, {
    color: PALETTE.graphiteMid,
    width: 2.7,
    opacity: 0.7,
    passes: 2,
  });
  // Gaps reserve native 240x150 hotspot cards centred at the documented anchors.
  for (const route of [
    [
      [90, 780],
      [160, 755],
      [190, 720],
    ],
    [
      [450, 660],
      [560, 650],
      [610, 530],
      [650, 490],
    ],
    [
      [910, 490],
      [1030, 540],
      [1110, 425],
      [1130, 350],
    ],
    [
      [1390, 350],
      [1490, 440],
      [1620, 430],
      [1710, 365],
    ],
    [
      [520, 650],
      [590, 795],
      [720, 850],
      [850, 820],
    ],
    [
      [1110, 820],
      [1250, 740],
      [1350, 700],
    ],
  ])
    trail(pen, route);

  // Triangle hills with construction lines, a bridge, a tree, and coordinate axes.
  pen.polyline([
    [180, 370],
    [285, 210],
    [390, 370],
    [180, 370],
  ]);
  pen.polyline([
    [325, 370],
    [394, 269],
    [472, 370],
  ]);
  pen.line(285, 210, 285, 370, { width: 1.5, opacity: 0.4 });
  pen.polyline(
    [
      [285, 352],
      [301, 352],
      [301, 370],
    ],
    { width: 1.5 },
  );
  pen.hatch(
    [
      [285, 210],
      [390, 370],
      [335, 370],
    ],
    { gap: 10, color: PALETTE.green, opacity: 0.5, width: 1.8 },
  );
  for (const y of [693, 717])
    pen.path(
      [
        [557, y],
        [600, y - 17],
        [648, y - 18],
        [687, y],
      ],
      { width: 3 },
    );
  for (let x = 565; x < 685; x += 19) pen.line(x, 681, x, 727, { width: 2 });
  pen.path(
    [
      [550, 740],
      [590, 754],
      [635, 739],
      [690, 749],
    ],
    { color: PALETTE.blue, width: 2.2, opacity: 0.5 },
  );
  pen.line(1440, 540, 1440, 627, { width: 4 });
  pen.line(1440, 586, 1417, 568, { width: 2.6 });
  pen.line(1440, 576, 1461, 551, { width: 2.6 });
  pen.path(
    [
      [1403, 579],
      [1378, 557],
      [1394, 526],
      [1398, 496],
      [1433, 481],
      [1460, 494],
      [1487, 516],
      [1481, 547],
      [1492, 568],
      [1467, 584],
      [1442, 579],
      [1403, 579],
    ],
    { color: PALETTE.green, width: 3.4 },
  );
  pen.line(1406, 631, 1477, 631, { width: 1.8 });
  arrow(pen, 1030, 265, 1030, 123, { head: 12, color: PALETTE.ink });
  arrow(pen, 1000, 235, 1170, 235, { head: 12, color: PALETTE.ink });
  arrow(pen, 1030, 235, 1131, 157, {
    head: 12,
    color: PALETTE.blue,
    width: 3.5,
  });
  for (let x = 1060; x < 1160; x += 30)
    pen.line(x, 230, x, 240, { width: 1.5 });
  pen.path(
    [
      [800, 935],
      [860, 907],
      [913, 939],
      [968, 920],
      [1030, 935],
    ],
    { color: PALETTE.blue, width: 2, opacity: 0.45 },
  );
  // Compass rose has no lettering, as chapter-map text is always live UI text.
  pen.ellipse(1742, 160, 61, 61, { opacity: 0.3, width: 1.6 });
  pen.polyline(
    [
      [1742, 87],
      [1756, 160],
      [1742, 233],
      [1728, 160],
      [1742, 87],
    ],
    { opacity: 0.45, width: 2.4 },
  );
  pen.polyline(
    [
      [1670, 160],
      [1742, 146],
      [1814, 160],
      [1742, 174],
      [1670, 160],
    ],
    { opacity: 0.3, width: 1.8 },
  );
  pen.hatch(
    [
      [1742, 87],
      [1756, 160],
      [1742, 160],
    ],
    { gap: 5, color: PALETTE.blue, opacity: 0.4 },
  );
  c.add(pen.flush());
  tape(c, { x: 72, y: 20, w: 134, h: 28, angle: -2 });
  tape(c, { x: 1720, y: 1028, w: 128, h: 28, angle: 2 });
}

function node(c, state) {
  paperPiece(c, {
    x: 13,
    y: 13,
    w: 214,
    h: 124,
    paper: state === "locked" ? "grey" : "light",
    outline: {
      color: PALETTE.graphite,
      width: 2.7,
      opacity: state === "locked" ? 0.45 : 0.8,
    },
    shadow: { dx: 1, dy: 2, blur: 1.5, opacity: 0.2 },
  });
  // Draw the common structure before consuming any state-specific random values.
  const pen = new Pen(c, {
    width: 1.8,
    overshoot: 0,
    jitter: 0.3,
    wobble: 0.5,
  });
  pen.line(27, 134, 88, 134, { color: PALETTE.graphiteLight, opacity: 0.4 });
  c.add(pen.flush());
  if (state === "current") {
    for (const [x, y, w, h] of [
      [14, 14, 212, 8],
      [14, 128, 212, 8],
      [14, 22, 8, 106],
      [218, 22, 8, 106],
    ]) {
      highlight(c, {
        x,
        y,
        w,
        h,
        color: PALETTE.highlightYellow,
        opacity: 0.95,
      });
    }
    // Blue pencil ring hugs the paper from outside so the yellow frame stays visible.
    pen.rect(6, 6, 228, 138, {
      color: PALETTE.blue,
      width: 3.6,
      r: 10,
      crossing: 0,
      opacity: 0.95,
    });
  }
  if (state === "locked") {
    for (const poly of [
      [
        [14, 14],
        [226, 14],
        [226, 19],
        [14, 19],
      ],
      [
        [14, 131],
        [226, 131],
        [226, 137],
        [14, 137],
      ],
      [
        [14, 20],
        [19, 20],
        [19, 130],
        [14, 130],
      ],
    ])
      pen.hatch(poly, { angle: -45, gap: 7, width: 2.1, opacity: 0.75 });
    // A 36px corner badge necessarily overlaps the inventory's nearly full-card textBox.
    c.add(
      `<rect x="186" y="96" width="40" height="43" rx="5" fill="${PALETTE.paperDark}"/>`,
    );
    pen.rect(190, 113, 32, 24, { width: 3.5, crossing: 0, r: 3 });
    pen.stroke(ellipsePoints(206, 113, 10, 13, 2, Math.PI, Math.PI), {
      width: 3.5,
    });
    pen.dot(206, 123, 2.2);
    pen.line(206, 123, 206, 130, { width: 2.2 });
  }
  if (state === "cleared") {
    c.add(`<circle cx="204" cy="118" r="21" fill="${PALETTE.paperLight}"/>`);
    pen.ellipse(204, 118, 20, 20, {
      color: PALETTE.green,
      width: 3,
      opacity: 0.95,
    });
    checkMark(pen, 204, 118, 28, {
      color: PALETTE.green,
      width: 5,
      opacity: 1,
      overshoot: 0,
    });
  }
  c.add(pen.flush());
}

export const assets = [
  {
    name: "map_background",
    dir: "map",
    width: 1920,
    height: 1080,
    note: "Opaque graph-paper map. Suggested 240x150 card centres: (320,690), (780,490), (1260,350), (1740,290), (980,820), (1480,700). No chapter text.",
    draw: background,
  },
  ...["locked", "open", "current", "cleared"].map((state) => ({
    name: `map_node_${state}`,
    dir: "map",
    width: 240,
    height: 150,
    seed: "map_node",
    textBox: [20, 20, 200, 110],
    slice: [20, 58, 56, 24],
    note: "Inventory textBox retained; locked/cleared badges occupy [182,96,44,43] inside its lower-right corner. Keep live text clear of that badge area. Stretch only modestly.",
    draw(c) {
      node(c, state);
    },
  })),
  {
    name: "map_hover_card",
    dir: "map",
    width: 480,
    height: 220,
    textBox: [24, 40, 432, 160],
    slice: [40, 24, 20, 24],
    note: "Top-centre pointer at x240. Horizontal 9-slice also scales the notch; keep native width when possible.",
    draw(c) {
      // Local notched-paper helper: paperPiece currently supports rectangular scraps only.
      const poly = [
        [14, 32],
        [226, 32],
        [240, 15],
        [254, 32],
        [466, 32],
        [466, 204],
        [14, 204],
      ];
      const d = pathOf(poly);
      const shadow = c.shadowFilter({ dx: 1, dy: 2, blur: 2, opacity: 0.23 });
      c.add(
        `<path d="${d}" fill="${PALETTE.paperLight}" filter="url(#${shadow})"/>`,
      );
      c.add(
        c.layer(`<path d="${d}" fill="${PALETTE.paperLight}"/>`, {
          kind: "fiber",
          box: { x0: 14, y0: 15, x1: 466, y1: 204 },
          pad: 3,
        }),
      );
      const pen = new Pen(c, {
        width: 2.7,
        overshoot: 0,
        wobble: 0.65,
        jitter: 0.4,
      });
      pen.polyline([...poly, poly[0]]);
      c.add(pen.flush());
    },
  },
  {
    name: "map_pin",
    dir: "map",
    width: 64,
    height: 80,
    note: "Pushpin tip anchor at (28,65).",
    draw(c) {
      const pen = new Pen(c, {
        width: 2.7,
        overshoot: 0,
        wobble: 0.5,
        jitter: 0.4,
      });
      pen.line(35, 43, 28, 65, { width: 3, color: PALETTE.graphite });
      pen.line(38, 44, 30, 64, { width: 1.4, color: PALETTE.graphiteLight });
      pen.polyline([
        [23, 23],
        [26, 39],
        [18, 45],
        [46, 45],
        [39, 38],
        [41, 23],
        [23, 23],
      ]);
      pen.hatch(
        [
          [25, 25],
          [27, 39],
          [23, 42],
          [42, 42],
          [37, 38],
          [39, 25],
        ],
        { gap: 4, color: PALETTE.blue, opacity: 0.7, width: 3 },
      );
      pen.ellipse(32, 23, 14, 7, { color: PALETTE.ink });
      pen.line(25, 21, 34, 19, { color: PALETTE.blue, width: 1.8 });
      c.add(pen.flush());
    },
  },
];
