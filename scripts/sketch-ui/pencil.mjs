/**
 * The pencil: wobbly, pressure-tapered strokes drawn as filled polygons.
 *
 *   const pen = new Pen(c, { color: PALETTE.graphite, width: 2.6 });
 *   pen.rect(20, 20, 300, 80, { r: 10 });
 *   pen.line(30, 110, 310, 112);
 *   c.add(pen.flush());
 *
 * A pen accumulates strokes and `flush()` returns them as one textured layer.
 * Group strokes into few pens (one texture filter per flush), and use a second
 * pen for a different texture (`kind: "soft"` for hatching and shading).
 *
 * Every stroke is drawn `passes` times with independent wobble, jitter and
 * pressure, which is what makes a rectangle look sketched rather than stroked.
 */

import { PALETTE, num } from "./canvas.mjs";
import { smoothNoise } from "./rng.mjs";

const TAU = Math.PI * 2;

/** Dense points along a polyline, roughly `step` apart. */
export function resample(points, step) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k += 1) {
      out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
    }
  }
  return out;
}

/** Catmull-Rom spline through `points`, sampled roughly every `step`. */
export function smooth(points, step = 5, closed = false) {
  if (points.length < 3) return resample(points, step);
  const pts = closed
    ? [points.at(-1), ...points, points[0], points[1]]
    : [points[0], ...points, points.at(-1)];
  const out = [];
  for (let i = 1; i < pts.length - 2; i += 1) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(2, Math.ceil(len / step));
    for (let k = 0; k < n; k += 1) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 *
          (2 * p1[0] +
            (-p0[0] + p2[0]) * t +
            (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
            (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 *
          (2 * p1[1] +
            (-p0[1] + p2[1]) * t +
            (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
            (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(closed ? out[0] : points.at(-1));
  return out;
}

export function ellipsePoints(cx, cy, rx, ry, step = 6, from = 0, sweep = TAU) {
  const circumference = Math.PI * (rx + ry);
  const n = Math.max(12, Math.ceil((circumference * (sweep / TAU)) / step));
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const a = from + (sweep * i) / n;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

/** Closed dense outline of a rounded rectangle, clockwise from the top-left. */
export function roundedRectPoints(x, y, w, h, r = 0, step = 6) {
  const rr = Math.min(r, w / 2, h / 2);
  if (rr <= 0.5) {
    return resample(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
        [x, y],
      ],
      step,
    ).slice(0, -1);
  }
  const arc = (cx, cy, from) =>
    ellipsePoints(cx, cy, rr, rr, step, from, Math.PI / 2);
  return [
    ...arc(x + rr, y + rr, Math.PI),
    ...arc(x + w - rr, y + rr, Math.PI * 1.5),
    ...arc(x + w - rr, y + h - rr, 0),
    ...arc(x + rr, y + h - rr, Math.PI / 2),
  ];
}

/** Axis-aligned bounds of a point list. */
export function boundsOf(points) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/** Parallel segments at `angle` (degrees) every `gap`, clipped to a polygon. */
export function hatchSegments(
  polygon,
  { angle = -45, gap = 8, offset = 0 } = {},
) {
  const a = (angle * Math.PI) / 180;
  const dir = [Math.cos(a), Math.sin(a)];
  const nrm = [-dir[1], dir[0]];
  const proj = polygon.map(([x, y]) => x * nrm[0] + y * nrm[1]);
  const lo = Math.min(...proj);
  const hi = Math.max(...proj);
  const segments = [];
  for (let s = lo + gap / 2 + offset; s < hi; s += gap) {
    const hits = [];
    for (let i = 0; i < polygon.length; i += 1) {
      const [x0, y0] = polygon[i];
      const [x1, y1] = polygon[(i + 1) % polygon.length];
      const s0 = x0 * nrm[0] + y0 * nrm[1];
      const s1 = x1 * nrm[0] + y1 * nrm[1];
      if ((s0 - s) * (s1 - s) > 0 || s0 === s1) continue;
      const u = (s - s0) / (s1 - s0);
      const px = x0 + (x1 - x0) * u;
      const py = y0 + (y1 - y0) * u;
      hits.push(px * dir[0] + py * dir[1]);
    }
    hits.sort((p, q) => p - q);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      segments.push([
        [nrm[0] * s + dir[0] * hits[i], nrm[1] * s + dir[1] * hits[i]],
        [nrm[0] * s + dir[0] * hits[i + 1], nrm[1] * s + dir[1] * hits[i + 1]],
      ]);
    }
  }
  return segments;
}

export class Pen {
  constructor(c, options = {}) {
    this.c = c;
    this.rng = c.rng;
    this.o = {
      color: PALETTE.graphite,
      width: 2.6, // nominal line width in px
      opacity: 0.88,
      wobble: 1.3, // lateral drift amplitude in px
      passes: 2,
      jitter: 1.1, // random endpoint displacement per pass
      overshoot: 4, // lines run past their end by up to this many px
      step: 7, // sampling distance along the stroke
      taper: 0.5, // 0 = pressure fades to a point, 1 = constant width
      kind: "pencil", // texture filter kind, see canvas.mjs
      ...options,
    };
    this.paths = [];
    this.box = null;
  }

  /** A pen with the same buffer settings but different stroke defaults. */
  opt(o) {
    return { ...this.o, ...o };
  }

  grow(points, pad) {
    const b = boundsOf(points);
    if (!this.box) {
      this.box = {
        x0: b.x0 - pad,
        y0: b.y0 - pad,
        x1: b.x1 + pad,
        y1: b.y1 + pad,
      };
    } else {
      this.box.x0 = Math.min(this.box.x0, b.x0 - pad);
      this.box.y0 = Math.min(this.box.y0, b.y0 - pad);
      this.box.x1 = Math.max(this.box.x1, b.x1 + pad);
      this.box.y1 = Math.max(this.box.y1, b.y1 + pad);
    }
  }

  /**
   * Draw one dense polyline `passes` times with wobble and pressure.  The
   * building block for every other stroke.
   */
  stroke(points, override = {}) {
    const o = this.opt(override);
    if (points.length < 2) return this;
    for (let pass = 0; pass < o.passes; pass += 1) {
      this.pass(points, o, pass);
    }
    return this;
  }

  pass(points, o, passIndex) {
    const rng = this.rng;
    // arclength parametrisation
    const lens = [0];
    for (let i = 1; i < points.length; i += 1) {
      lens.push(
        lens[i - 1] +
          Math.hypot(
            points[i][0] - points[i - 1][0],
            points[i][1] - points[i - 1][1],
          ),
      );
    }
    const total = lens.at(-1);
    if (total < 0.5) return;
    const drift = smoothNoise(rng, total / 90 + 1);
    const flutter = smoothNoise(rng, total / 22 + 1);
    const press = smoothNoise(rng, total / 60 + 1);
    const wob = o.wobble * Math.min(1, 0.35 + total / 160);
    const startJ = [
      rng.range(-o.jitter, o.jitter),
      rng.range(-o.jitter, o.jitter),
    ];
    const endJ = [
      rng.range(-o.jitter, o.jitter),
      rng.range(-o.jitter, o.jitter),
    ];
    const widthScale = rng.range(0.78, 1.18) * (passIndex === 0 ? 1 : 0.82);
    const opacity = o.opacity * rng.range(0.7, 1) * (passIndex === 0 ? 1 : 0.8);

    const centre = [];
    const widths = [];
    for (let i = 0; i < points.length; i += 1) {
      const t = lens[i] / total;
      const prev = points[Math.max(0, i - 1)];
      const nextPoint = points[Math.min(points.length - 1, i + 1)];
      let dx = nextPoint[0] - prev[0];
      let dy = nextPoint[1] - prev[1];
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      const lateral = drift(t) * wob + flutter(t) * wob * 0.3;
      const jx = startJ[0] * (1 - t) + endJ[0] * t;
      const jy = startJ[1] * (1 - t) + endJ[1] * t;
      centre.push([
        points[i][0] + -dy * lateral + jx,
        points[i][1] + dx * lateral + jy,
      ]);
      // pressure: ramps in over the first ~10 %, out over the last ~16 %
      const ramp = Math.min(1, t / 0.1, (1 - t) / 0.16);
      const profile =
        o.taper + (1 - o.taper) * Math.sin((Math.PI / 2) * Math.max(0, ramp));
      widths.push(
        Math.max(0.4, o.width * widthScale * profile * (0.9 + 0.12 * press(t))),
      );
    }

    // overshoot: extend the ends along their tangent
    if (o.overshoot > 0) {
      const extend = (from, to, amount) => {
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const dl = Math.hypot(dx, dy) || 1;
        return [to[0] + (dx / dl) * amount, to[1] + (dy / dl) * amount];
      };
      const e0 = rng.range(-o.overshoot * 0.3, o.overshoot * 0.7);
      const e1 = rng.range(-o.overshoot * 0.3, o.overshoot);
      centre[0] = extend(centre[1], centre[0], e0);
      centre.push(extend(centre.at(-2), centre.at(-1), e1));
      widths.push(widths.at(-1));
    }

    this.paths.push(ribbon(centre, widths, o.color, opacity));
    this.grow(centre, o.width * 2 + o.wobble * 2 + o.jitter + 4);
  }

  /** A single straight-ish stroke. */
  line(x1, y1, x2, y2, override = {}) {
    const o = this.opt(override);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(2, Math.ceil(len / o.step));
    const pts = [];
    for (let i = 0; i <= n; i += 1)
      pts.push([x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
    return this.stroke(pts, override);
  }

  /** Smooth stroke through control points. */
  path(points, override = {}) {
    const o = this.opt(override);
    return this.stroke(smooth(points, o.step), override);
  }

  /** Independent straight strokes joining consecutive points. */
  polyline(points, override = {}) {
    for (let i = 1; i < points.length; i += 1) {
      this.line(
        points[i - 1][0],
        points[i - 1][1],
        points[i][0],
        points[i][1],
        override,
      );
    }
    return this;
  }

  /** Closed outline, hand-drawn as one loop whose ends overlap. */
  outline(points, override = {}) {
    const o = this.opt(override);
    const dense = resample([...points, points[0]], o.step).slice(0, -1);
    const start = this.rng.int(0, dense.length - 1);
    const rotated = [...dense.slice(start), ...dense.slice(0, start)];
    const overlap = Math.max(2, Math.round(rotated.length * 0.03));
    const looped = [...rotated, ...rotated.slice(0, overlap + 1)];
    return this.stroke(looped, override);
  }

  /** Sketchy rectangle; sharp corners are four crossing strokes. */
  rect(x, y, w, h, override = {}) {
    const o = this.opt(override);
    if ((override.r ?? 0) > 0.5) {
      return this.outline(
        roundedRectPoints(x, y, w, h, override.r, o.step),
        override,
      );
    }
    const crossing = override.crossing ?? 3;
    const rng = this.rng;
    const j = () => rng.range(-crossing, crossing) * 0.5;
    this.line(
      x - crossing + j(),
      y + j(),
      x + w + crossing + j(),
      y + j(),
      override,
    );
    this.line(
      x + w + j(),
      y - crossing + j(),
      x + w + j(),
      y + h + crossing + j(),
      override,
    );
    this.line(
      x + w + crossing + j(),
      y + h + j(),
      x - crossing + j(),
      y + h + j(),
      override,
    );
    this.line(
      x + j(),
      y + h + crossing + j(),
      x + j(),
      y - crossing + j(),
      override,
    );
    return this;
  }

  ellipse(cx, cy, rx, ry, override = {}) {
    const o = this.opt(override);
    const from = this.rng.range(0, TAU);
    const pts = ellipsePoints(
      cx,
      cy,
      rx,
      ry,
      o.step,
      from,
      TAU + this.rng.range(0.15, 0.4),
    );
    return this.stroke(pts, override);
  }

  /** Straight hatching lines inside a polygon. */
  hatch(polygon, { angle = -45, gap = 8, offset = 0, ...override } = {}) {
    for (const [[x0, y0], [x1, y1]] of hatchSegments(polygon, {
      angle,
      gap,
      offset,
    })) {
      this.line(x0, y0, x1, y1, {
        passes: 1,
        overshoot: 1.5,
        jitter: 0.8,
        wobble: 0.8,
        ...override,
      });
    }
    return this;
  }

  /** Back-and-forth scribble fill inside a polygon. */
  scribble(polygon, { angle = -35, gap = 6, ...override } = {}) {
    const segs = hatchSegments(polygon, { angle, gap });
    if (!segs.length) return this;
    const pts = [];
    segs.forEach(([a, b], i) => {
      if (i % 2 === 0) pts.push(a, b);
      else pts.push(b, a);
    });
    return this.stroke(resample(pts, this.o.step * 2), {
      passes: 1,
      taper: 0.9,
      overshoot: 0,
      ...override,
    });
  }

  dot(x, y, r = 2.5, override = {}) {
    const pts = ellipsePoints(
      x,
      y,
      r,
      r * this.rng.range(0.8, 1),
      2,
      this.rng.range(0, TAU),
      TAU * 1.1,
    );
    return this.stroke(pts, {
      passes: 1,
      width: Math.max(1.6, r * 0.9),
      overshoot: 0,
      wobble: 0.3,
      jitter: 0.3,
      ...override,
    });
  }

  /** The accumulated strokes as one textured SVG layer; empties the pen. */
  flush(extra = {}) {
    if (!this.paths.length) return "";
    const out = this.c.layer(this.paths.join(""), {
      box: this.box,
      kind: this.o.kind,
      ...extra,
    });
    this.paths = [];
    this.box = null;
    return out;
  }
}

/** Closed polygon for a variable-width stroke along `centre`. */
function ribbon(centre, widths, color, opacity) {
  const left = [];
  const right = [];
  for (let i = 0; i < centre.length; i += 1) {
    const prev = centre[Math.max(0, i - 1)];
    const next = centre[Math.min(centre.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const h = widths[i] / 2;
    left.push([centre[i][0] - dy * h, centre[i][1] + dx * h]);
    right.push([centre[i][0] + dy * h, centre[i][1] - dx * h]);
  }
  const fmt = ([x, y]) => `${num(x)} ${num(y)}`;
  const hEnd = (widths.at(-1) / 2).toFixed(2);
  const hStart = (widths[0] / 2).toFixed(2);
  const d =
    `M${fmt(left[0])}L` +
    left.slice(1).map(fmt).join("L") +
    `A${hEnd} ${hEnd} 0 0 0 ${fmt(right.at(-1))}L` +
    right.slice(0, -1).reverse().map(fmt).join("L") +
    `A${hStart} ${hStart} 0 0 0 ${fmt(left[0])}Z`;
  return `<path d="${d}" fill="${color}" fill-opacity="${String(Math.round(opacity * 100) / 100)}"/>`;
}
