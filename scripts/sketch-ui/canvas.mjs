/**
 * `Canvas` is one asset's SVG document: a seeded generator, an id counter, a
 * list of body fragments and the shared texture filters.
 *
 * Texture is the whole point of the style.  The strokes themselves are
 * wobbly, pressure-tapered polygons (see pencil.mjs); the filters here add the
 * paper "tooth" that eats small holes into graphite and colored pencil, and the
 * fibre speckle on paper.  Filters are generated per layer with a bounding box
 * so a tiny button never pays for a full-screen turbulence pass.
 */

import { hashString, makeRng } from "./rng.mjs";

export const PALETTE = {
  paper: "#f3ecd8",
  paperLight: "#fbf7ea",
  paperWhite: "#fffdf6",
  paperDark: "#e4d9bd",
  paperEdge: "#c9bb97",
  kraft: "#d8be8e",
  kraftDark: "#b99a64",
  graphite: "#32323a",
  graphiteMid: "#585861",
  graphiteLight: "#8b8b94",
  graphiteFaint: "#b8b4a8",
  gridBlue: "#9db8d8",
  ruleBlue: "#a9c2dc",
  margin: "#d98a84",
  blue: "#4a79bd",
  red: "#c7504a",
  green: "#58996a",
  yellow: "#e6c14b",
  orange: "#df8a3d",
  purple: "#8566b0",
  pink: "#df8fa6",
  highlightYellow: "#ffe35c",
  highlightPink: "#ff9fc0",
  highlightGreen: "#9be08e",
  highlightBlue: "#8fd0ff",
  ink: "#243a73",
};

export const num = (value) => {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

export class Canvas {
  constructor(name, width, height, seed = name) {
    this.name = name;
    this.w = width;
    this.h = height;
    this.rng = makeRng(hashString(seed));
    this.defs = [];
    this.body = [];
    this.nextId = 0;
  }

  /** A document-unique id such as `f3`. */
  id(prefix = "i") {
    this.nextId += 1;
    return `${prefix}${String(this.nextId)}`;
  }

  add(...fragments) {
    for (const fragment of fragments) {
      if (fragment) this.body.push(fragment);
    }
    return this;
  }

  def(fragment) {
    this.defs.push(fragment);
  }

  /**
   * Wrap `content` in a group with a texture filter evaluated over `box`
   * (`{x0, y0, x1, y1}` in the group's own coordinates).  `kind` is one of
   * `pencil`, `soft`, `wash`, `fiber`, `none`.
   */
  layer(
    content,
    { box, kind = "pencil", opacity = 1, transform, pad = 10 } = {},
  ) {
    if (!content) return "";
    const attrs = [];
    if (kind !== "none") {
      const b = box ?? { x0: 0, y0: 0, x1: this.w, y1: this.h };
      const id = this.id("f");
      this.def(
        textureFilter(id, kind, {
          x: b.x0 - pad,
          y: b.y0 - pad,
          width: b.x1 - b.x0 + pad * 2,
          height: b.y1 - b.y0 + pad * 2,
          seed: this.rng.int(1, 9999),
        }),
      );
      attrs.push(`filter="url(#${id})"`);
    }
    if (opacity !== 1) attrs.push(`opacity="${num(opacity)}"`);
    if (transform) attrs.push(`transform="${transform}"`);
    return `<g ${attrs.join(" ")}>${content}</g>`;
  }

  /** A soft drop shadow filter id for a paper piece. */
  shadowFilter({
    dx = 3,
    dy = 5,
    blur = 4,
    opacity = 0.32,
    color = "#2a2216",
  } = {}) {
    const id = this.id("s");
    this.def(
      `<filter id="${id}" filterUnits="userSpaceOnUse" x="-20" y="-20" width="${num(this.w + 40)}" height="${num(this.h + 40)}" color-interpolation-filters="sRGB">` +
        `<feGaussianBlur in="SourceAlpha" stdDeviation="${num(blur)}"/>` +
        `<feOffset dx="${num(dx)}" dy="${num(dy)}" result="b"/>` +
        `<feFlood flood-color="${color}" flood-opacity="${num(opacity)}"/>` +
        `<feComposite in2="b" operator="in" result="sh"/>` +
        `<feMerge><feMergeNode in="sh"/><feMergeNode in="SourceGraphic"/></feMerge>` +
        `</filter>`,
    );
    return id;
  }

  svg() {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${String(this.w)}" height="${String(this.h)}" viewBox="0 0 ${String(this.w)} ${String(this.h)}">\n` +
      `<defs>\n${this.defs.join("\n")}\n</defs>\n${this.body.join("\n")}\n</svg>\n`
    );
  }
}

/**
 * `alpha = k * noise + b` on a fine fractal-noise field: where the noise dips
 * the stroke loses opacity, which reads as pencil skipping over paper tooth.
 */
function textureFilter(id, kind, { x, y, width, height, seed }) {
  const region = `filterUnits="userSpaceOnUse" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" color-interpolation-filters="sRGB"`;
  const mask = (k, b) =>
    `<feColorMatrix in="tooth" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${String(k)} 0 0 0 ${String(b)}" result="mask"/>`;
  switch (kind) {
    case "pencil":
      return (
        `<filter id="${id}" ${region}>` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="${String(seed)}" result="warp"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="warp" scale="2.4" xChannelSelector="R" yChannelSelector="G" result="rough"/>` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${String(seed + 7)}" result="tooth"/>` +
        mask(3.4, -0.62) +
        `<feComposite in="rough" in2="mask" operator="in"/>` +
        `</filter>`
      );
    case "soft":
      return (
        `<filter id="${id}" ${region}>` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="${String(seed)}" result="warp"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="warp" scale="2" xChannelSelector="R" yChannelSelector="G" result="rough"/>` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="${String(seed + 7)}" result="tooth"/>` +
        mask(4.2, -1.25) +
        `<feComposite in="rough" in2="mask" operator="in"/>` +
        `</filter>`
      );
    case "wash":
      return (
        `<filter id="${id}" ${region}>` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="${String(seed)}" result="warp"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="warp" scale="3" xChannelSelector="R" yChannelSelector="G" result="rough"/>` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="3" seed="${String(seed + 7)}" result="tooth"/>` +
        mask(3.8, -0.95) +
        `<feComposite in="rough" in2="mask" operator="in"/>` +
        `</filter>`
      );
    case "fiber":
      // Not a mask: paints brown speckle and a faint mottle onto whatever the
      // layer holds, so apply it to a flat paper-coloured fill.
      return (
        `<filter id="${id}" ${region}>` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="${String(seed)}" result="n"/>` +
        `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.34  0 0 0 0 0.2  1.25 0 0 0 -0.66" result="speck"/>` +
        `<feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves="2" seed="${String(seed + 3)}" result="m"/>` +
        `<feColorMatrix in="m" type="matrix" values="0 0 0 0 0.66  0 0 0 0 0.55  0 0 0 0 0.32  0.16 0 0 0 -0.065" result="mottle"/>` +
        `<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="mottle"/><feMergeNode in="speck"/></feMerge>` +
        `<feComposite in2="SourceGraphic" operator="in"/>` +
        `</filter>`
      );
    default:
      throw new Error(`unknown texture kind ${kind}`);
  }
}
