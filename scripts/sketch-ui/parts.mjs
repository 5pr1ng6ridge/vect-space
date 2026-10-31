/**
 * Reusable sketchbook parts built on the pencil: paper scraps, ruled and grid
 * pages, tape, highlighter swipes, washes and small pencil marks.
 *
 * Paper-like parts draw straight into the canvas (`c.add`) and return the
 * geometry they used so callers can hatch, label or overlay it.  Mark helpers
 * take a `Pen` and only add strokes; the caller flushes.
 */

import { PALETTE, num } from "./canvas.mjs";
import {
  Pen,
  boundsOf,
  ellipsePoints,
  resample,
  roundedRectPoints,
} from "./pencil.mjs";
import { smoothNoise } from "./rng.mjs";

const d = (points) =>
  `M${points.map(([x, y]) => `${num(x)} ${num(y)}`).join("L")}Z`;
const dOpen = (points) =>
  `M${points.map(([x, y]) => `${num(x)} ${num(y)}`).join("L")}`;

export const pathOf = d;

/**
 * Polygon of a paper scrap.  `torn` lists sides (0 top, 1 right, 2 bottom,
 * 3 left) whose edge is ripped; other sides are cut with a slightly unsteady
 * hand.  `fold` ("tr" | "br" | "bl" | "tl") dog-ears that corner by `foldSize`.
 */
export function scrapPoly(
  c,
  x,
  y,
  w,
  h,
  { jitter = 1.1, torn = [], tornAmp = 3, fold = null, foldSize = 34 } = {},
) {
  const rng = c.rng;
  let corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  let foldTri = null;
  if (fold) {
    const idx = { tl: 0, tr: 1, br: 2, bl: 3 }[fold];
    const [cx, cy] = corners[idx];
    const prev = corners[(idx + 3) % 4];
    const next = corners[(idx + 1) % 4];
    const toward = (from, to, len) => {
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const dl = Math.hypot(dx, dy);
      return [from[0] + (dx / dl) * len, from[1] + (dy / dl) * len];
    };
    const a = toward([cx, cy], prev, foldSize);
    const b = toward([cx, cy], next, foldSize);
    const inner = [a[0] + b[0] - cx, a[1] + b[1] - cy];
    corners = [...corners.slice(0, idx), a, b, ...corners.slice(idx + 1)];
    foldTri = [a, b, inner];
  }
  const points = [];
  const sides = [];
  for (let i = 0; i < corners.length; i += 1) {
    const p = corners[i];
    const q = corners[(i + 1) % corners.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const isTorn = torn.includes(i) && !fold;
    const n = Math.max(1, Math.ceil(len / (isTorn ? 7 : 26)));
    const nx = (q[1] - p[1]) / len;
    const ny = -(q[0] - p[0]) / len;
    const wave = smoothNoise(rng, len / 60 + 1);
    const side = [];
    for (let k = 0; k < n; k += 1) {
      const t = k / n;
      const off = isTorn
        ? wave(t) * tornAmp * 0.8 + rng.range(-tornAmp, tornAmp) * 0.6
        : k === 0
          ? 0
          : wave(t) * jitter + rng.range(-jitter, jitter) * 0.3;
      side.push([
        p[0] + (q[0] - p[0]) * t + nx * off,
        p[1] + (q[1] - p[1]) * t + ny * off,
      ]);
    }
    side.push(q);
    sides.push({ points: side, torn: isTorn });
    points.push(...side.slice(0, -1));
  }
  return {
    points,
    sides,
    foldTri,
    box: { x0: x, y0: y, x1: x + w, y1: y + h },
  };
}

const PAPER_TINTS = {
  cream: PALETTE.paper,
  light: PALETTE.paperLight,
  white: PALETTE.paperWhite,
  dark: PALETTE.paperDark,
  kraft: PALETTE.kraft,
  blue: "#e3edf7",
  pink: "#f8e3e6",
  yellow: "#f9efb4",
  green: "#e2f0dc",
  grey: "#dcdad2",
};

/**
 * A scrap of paper with shadow, fibre texture, optional rules and a pencil
 * outline.  Returns `{ poly, inner }` where `inner` is a rectangle inset from
 * the edges that is safe for content.
 */
export function paperPiece(c, opts) {
  const {
    x,
    y,
    w,
    h,
    tilt = 0,
    paper = "cream",
    edge = "cut", // "cut" | "round" | "torn"
    r = 14,
    torn = [2],
    tornAmp = 3,
    fold = null,
    foldSize = 34,
    shadow = { dx: 3, dy: 5, blur: 4, opacity: 0.3 },
    outline = { color: PALETTE.graphite, width: 3.1, opacity: 0.88 },
    rules = null, // null | "ruled" | "grid" | "dots"
    ruleGap = 36,
    ruleInset = 22,
    margin = false,
    holes = false,
    inset = 22,
  } = opts;
  const fill = PAPER_TINTS[paper] ?? paper;
  const rotate = tilt
    ? ` transform="rotate(${num(tilt)} ${num(x + w / 2)} ${num(y + h / 2)})"`
    : "";
  const parts = [];

  const poly =
    edge === "round"
      ? {
          points: roundedRectPoints(x, y, w, h, r, 8),
          sides: [],
          foldTri: null,
        }
      : scrapPoly(c, x, y, w, h, {
          torn: edge === "torn" ? torn : [],
          tornAmp,
          fold,
          foldSize,
        });
  const box = boundsOf(poly.points);

  if (shadow) {
    const sid = c.shadowFilter(shadow);
    parts.push(
      `<g filter="url(#${sid})"><path d="${d(poly.points)}" fill="${fill}"/></g>`,
    );
  }
  parts.push(
    c.layer(`<path d="${d(poly.points)}" fill="${fill}"/>`, {
      box,
      kind: "fiber",
      pad: 4,
    }),
  );

  const clipId = c.id("c");
  c.def(`<clipPath id="${clipId}"><path d="${d(poly.points)}"/></clipPath>`);
  const lines = [];
  if (rules === "ruled")
    lines.push(
      ...ruledLines(c, x, y, w, h, {
        gap: ruleGap,
        inset: ruleInset,
        top: ruleInset + ruleGap,
        color: PALETTE.ruleBlue,
      }),
    );
  if (rules === "grid")
    lines.push(
      ...gridLines(c, x, y, w, h, { gap: ruleGap, color: PALETTE.gridBlue }),
    );
  if (rules === "dots")
    lines.push(
      ...dotGrid(x, y, w, h, { gap: ruleGap, color: PALETTE.graphiteFaint }),
    );
  if (margin) lines.push(marginLine(c, x + inset + 54, y, h, PALETTE.margin));
  if (lines.length)
    parts.push(`<g clip-path="url(#${clipId})">${lines.join("")}</g>`);
  if (holes) parts.push(punchHoles(c, x + 26, y, h, { gap: 120 }));

  if (poly.foldTri) {
    const [a, b, inner] = poly.foldTri;
    parts.push(
      `<path d="${d([a, inner, b])}" fill="${PALETTE.paperDark}" stroke="${PALETTE.paperEdge}" stroke-width="1.2" stroke-linejoin="round"/>`,
    );
  }

  if (outline) {
    const pen = new Pen(c, {
      color: outline.color,
      width: outline.width,
      opacity: outline.opacity,
      passes: 2,
      wobble: 1.1,
    });
    if (edge === "round") {
      pen.outline(poly.points);
    } else {
      for (const side of poly.sides) {
        if (side.torn) {
          pen.stroke(resample(side.points, 5), {
            passes: 1,
            width: 1.2,
            opacity: 0.35,
            color: PALETTE.paperEdge,
            wobble: 0.2,
            jitter: 0.2,
            overshoot: 0,
          });
        } else {
          pen.stroke(side.points, { overshoot: 3 });
        }
      }
      if (poly.foldTri) {
        const [a, b, inner] = poly.foldTri;
        pen.line(a[0], a[1], inner[0], inner[1], { passes: 1, width: 1.8 });
        pen.line(inner[0], inner[1], b[0], b[1], { passes: 1, width: 1.8 });
      }
    }
    parts.push(pen.flush());
  }

  c.add(`<g${rotate}>${parts.join("")}</g>`);
  return {
    poly: poly.points,
    inner: { x: x + inset, y: y + inset, w: w - inset * 2, h: h - inset * 2 },
  };
}

/** Thin wobbly horizontal rules; returns SVG strings. */
export function ruledLines(
  c,
  x,
  y,
  w,
  h,
  {
    gap = 36,
    inset = 18,
    top = 60,
    color = PALETTE.ruleBlue,
    opacity = 0.9,
    width = 1.6,
  } = {},
) {
  const dParts = [];
  for (let yy = y + top; yy < y + h - inset * 0.6; yy += gap) {
    dParts.push(faintLine(c, x + inset * 0.3, x + w - inset * 0.3, yy));
  }
  return dParts.length
    ? [
        `<path d="${dParts.join("")}" fill="none" stroke="${color}" stroke-width="${num(width)}" stroke-opacity="${num(opacity)}" stroke-linecap="round"/>`,
      ]
    : [];
}

export function gridLines(
  c,
  x,
  y,
  w,
  h,
  {
    gap = 32,
    color = PALETTE.gridBlue,
    opacity = 0.55,
    width = 1.2,
    major = 0,
  } = {},
) {
  const dParts = [];
  const strong = [];
  for (let yy = y + gap; yy < y + h; yy += gap) {
    (major && Math.round((yy - y) / gap) % major === 0 ? strong : dParts).push(
      faintLine(c, x, x + w, yy, 0.5),
    );
  }
  for (let xx = x + gap; xx < x + w; xx += gap) {
    (major && Math.round((xx - x) / gap) % major === 0 ? strong : dParts).push(
      vFaintLine(c, xx, y, y + h, 0.5),
    );
  }
  const out = [
    `<path d="${dParts.join("")}" fill="none" stroke="${color}" stroke-width="${num(width)}" stroke-opacity="${num(opacity)}" stroke-linecap="round"/>`,
  ];
  if (strong.length)
    out.push(
      `<path d="${strong.join("")}" fill="none" stroke="${color}" stroke-width="${num(width * 1.5)}" stroke-opacity="${num(Math.min(1, opacity + 0.2))}" stroke-linecap="round"/>`,
    );
  return out;
}

export function dotGrid(
  x,
  y,
  w,
  h,
  { gap = 32, color = PALETTE.graphiteFaint, r = 1.8, opacity = 0.8 } = {},
) {
  const cells = [];
  for (let yy = y + gap; yy < y + h; yy += gap) {
    for (let xx = x + gap; xx < x + w; xx += gap)
      cells.push(
        `M${num(xx - r)} ${num(yy)}a${num(r)} ${num(r)} 0 1 0 ${num(r * 2)} 0a${num(r)} ${num(r)} 0 1 0 ${num(-r * 2)} 0`,
      );
  }
  return [
    `<path d="${cells.join("")}" fill="${color}" fill-opacity="${num(opacity)}"/>`,
  ];
}

export function marginLine(c, x, y, h, color = PALETTE.margin) {
  const pts = [];
  const wob = smoothNoise(c.rng, 6);
  for (let t = 0; t <= 1.0001; t += 1 / 28)
    pts.push([x + wob(t) * 1.2, y + h * t]);
  return `<path d="${dOpen(pts)}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.7" stroke-linecap="round"/><path d="${dOpen(pts.map(([px, py]) => [px + 6, py]))}" fill="none" stroke="${color}" stroke-width="1.4" stroke-opacity="0.5" stroke-linecap="round"/>`;
}

function faintLine(c, x1, x2, y, scale = 1) {
  const n = Math.max(2, Math.ceil((x2 - x1) / 40));
  const wob = smoothNoise(c.rng, n);
  const pts = [];
  for (let i = 0; i <= n; i += 1)
    pts.push([x1 + ((x2 - x1) * i) / n, y + wob(i / n) * 1.1 * scale]);
  return dOpen(pts);
}

function vFaintLine(c, x, y1, y2, scale = 1) {
  const n = Math.max(2, Math.ceil((y2 - y1) / 40));
  const wob = smoothNoise(c.rng, n);
  const pts = [];
  for (let i = 0; i <= n; i += 1)
    pts.push([x + wob(i / n) * 1.1 * scale, y1 + ((y2 - y1) * i) / n]);
  return dOpen(pts);
}

/** Binder holes down the left edge, as dark ellipses with a lit rim. */
export function punchHoles(c, x, y, h, { gap = 120, r = 11 } = {}) {
  const out = [];
  for (let yy = y + gap * 0.6; yy < y + h - gap * 0.3; yy += gap) {
    out.push(
      `<ellipse cx="${num(x)}" cy="${num(yy)}" rx="${num(r)}" ry="${num(r * 0.92)}" fill="#2b2822" fill-opacity="0.5"/><ellipse cx="${num(x + 0.8)}" cy="${num(yy + 1)}" rx="${num(r - 1.5)}" ry="${num(r * 0.92 - 1.5)}" fill="#1d1b17" fill-opacity="0.35"/>`,
    );
  }
  return out.join("");
}

/** Translucent masking tape with notched ends. */
export function tape(
  c,
  { x, y, w, h, angle = 0, color = "#ecd9a0", opacity = 0.82 },
) {
  const rng = c.rng;
  const zig = (x0, dir) => {
    const pts = [];
    const n = Math.max(3, Math.round(h / 5));
    for (let i = 0; i <= n; i += 1)
      pts.push([
        x0 + dir * (i % 2 === 0 ? 0 : rng.range(2.5, 4.5)),
        y + (h * i) / n,
      ]);
    return pts;
  };
  const left = zig(x, -1);
  const right = zig(x + w, 1);
  const poly = [...left, ...right.reverse()];
  const id = c.id("t");
  c.def(`<clipPath id="${id}"><path d="${d(poly)}"/></clipPath>`);
  const streaks = [];
  for (let i = 0; i < 4; i += 1) {
    const sy = y + rng.range(0.15, 0.85) * h;
    streaks.push(
      `<path d="M${num(x + rng.range(0, w * 0.2))} ${num(sy)}L${num(x + rng.range(w * 0.6, w))} ${num(sy + rng.range(-1.5, 1.5))}" stroke="#fff" stroke-opacity="0.35" stroke-width="1.2" fill="none"/>`,
    );
  }
  const sid = c.shadowFilter({ dx: 1, dy: 2, blur: 1.6, opacity: 0.22 });
  c.add(
    `<g transform="rotate(${num(angle)} ${num(x + w / 2)} ${num(y + h / 2)})" filter="url(#${sid})"><path d="${d(poly)}" fill="${color}" fill-opacity="${num(opacity)}"/><g clip-path="url(#${id})">${streaks.join("")}</g></g>`,
  );
  return poly;
}

/** A marker swipe: an uneven translucent band, slightly slanted at the ends. */
export function highlight(
  c,
  { x, y, w, h, color = PALETTE.highlightYellow, opacity = 0.55, angle = 0 },
) {
  const rng = c.rng;
  const top = [];
  const bottom = [];
  const n = Math.max(4, Math.ceil(w / 30));
  const wob = smoothNoise(rng, n / 2);
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    top.push([
      x + w * t + (i === 0 ? rng.range(0, 6) : 0),
      y + wob(t) * 2 + rng.range(-0.8, 0.8),
    ]);
    bottom.push([
      x + w * t - (i === n ? rng.range(0, 6) : 0),
      y + h + wob(1 - t) * 2 + rng.range(-0.8, 0.8),
    ]);
  }
  const poly = [...top, ...bottom.reverse()];
  const body = `<path d="${d(poly)}" fill="${color}" fill-opacity="${num(opacity)}"/>`;
  c.add(
    c.layer(body, {
      box: boundsOf(poly),
      kind: "wash",
      transform: angle
        ? `rotate(${num(angle)} ${num(x + w / 2)} ${num(y + h / 2)})`
        : undefined,
      pad: 6,
    }),
  );
  return poly;
}

/** Colored-pencil fill of a polygon (grainy flat wash). */
export function wash(c, points, color, { opacity = 0.35 } = {}) {
  c.add(
    c.layer(
      `<path d="${d(points)}" fill="${color}" fill-opacity="${num(opacity)}"/>`,
      { box: boundsOf(points), kind: "wash", pad: 6 },
    ),
  );
}

/** Shade a polygon with soft hatching in `color`. */
export function shade(
  c,
  points,
  {
    color = PALETTE.graphiteMid,
    angle = -45,
    gap = 7,
    width = 1.8,
    opacity = 0.5,
  } = {},
) {
  const pen = new Pen(c, { color, width, opacity, kind: "soft", passes: 1 });
  pen.hatch(points, { angle, gap });
  c.add(pen.flush());
}

// ---------------------------------------------------------------------------
// Pencil marks (add strokes to a pen; caller flushes)

export function checkMark(pen, cx, cy, size, override = {}) {
  const s = size / 2;
  pen.line(cx - s * 0.95, cy + s * 0.05, cx - s * 0.3, cy + s * 0.75, {
    overshoot: 1,
    ...override,
  });
  pen.path(
    [
      [cx - s * 0.3, cy + s * 0.75],
      [cx + s * 0.35, cy - s * 0.1],
      [cx + s * 0.95, cy - s * 0.85],
    ],
    { overshoot: 2, ...override },
  );
  return pen;
}

export function crossMark(pen, cx, cy, size, override = {}) {
  const s = size / 2;
  pen.line(cx - s, cy - s, cx + s, cy + s, override);
  pen.line(cx + s, cy - s * 0.9, cx - s * 0.9, cy + s, override);
  return pen;
}

export function arrow(
  pen,
  x1,
  y1,
  x2,
  y2,
  { head = 14, curve = 0, ...override } = {},
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mid = [(x1 + x2) / 2 + nx * curve, (y1 + y2) / 2 + ny * curve];
  if (curve) pen.path([[x1, y1], mid, [x2, y2]], override);
  else pen.line(x1, y1, x2, y2, override);
  const tx = curve ? x2 - mid[0] : dx;
  const ty = curve ? y2 - mid[1] : dy;
  const ta = Math.atan2(ty, tx);
  for (const side of [-1, 1]) {
    const a = ta + Math.PI + side * 0.5;
    pen.line(x2, y2, x2 + Math.cos(a) * head, y2 + Math.sin(a) * head, {
      passes: 1,
      overshoot: 0,
      ...override,
    });
  }
  return pen;
}

export function star(pen, cx, cy, r, override = {}) {
  const pts = [];
  for (let i = 0; i < 5; i += 1) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  pts.push(pts[0]);
  return pen.polyline(pts, { overshoot: 2, ...override });
}

export function squiggle(
  pen,
  x1,
  x2,
  y,
  { amp = 4, waves = 8, ...override } = {},
) {
  const pts = [];
  const n = waves * 2;
  for (let i = 0; i <= n; i += 1)
    pts.push([
      x1 + ((x2 - x1) * i) / n,
      y + (i % 2 === 0 ? -amp : amp) * pen.rng.range(0.7, 1.1),
    ]);
  return pen.path(pts, { passes: 1, ...override });
}

/** L-shaped corner brackets around a rectangle, like crop marks. */
export function cornerMarks(pen, x, y, w, h, len = 18, override = {}) {
  const corners = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x + w, y + h, -1, -1],
    [x, y + h, 1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    pen.line(cx, cy, cx + sx * len, cy, { passes: 1, ...override });
    pen.line(cx, cy, cx, cy + sy * len, { passes: 1, ...override });
  }
  return pen;
}

/** A scribbled circle (two loose revolutions) around a point. */
export function circleScribble(pen, cx, cy, rx, ry, override = {}) {
  const from = pen.rng.range(0, Math.PI * 2);
  const pts = [];
  for (let i = 0; i <= 60; i += 1) {
    const t = i / 60;
    const k = 1 + 0.06 * t;
    const a = from + t * Math.PI * 2 * 1.9;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return pen.path(pts, { passes: 1, taper: 0.4, ...override });
}

export { ellipsePoints, roundedRectPoints };
