/** Raw RGBA readback of one 320x180 `captureThumbnail()` frame. */
export interface PixelFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Decodes one `captureThumbnail()` PNG into its 320x180 RGB pixels. */
export async function capturePixels(source: {
  captureThumbnail(): string | null;
}): Promise<PixelFrame | null> {
  const dataUrl = source.captureThumbnail();
  if (dataUrl === null) return null;
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.drawImage(image, 0, 0, 320, 180);
  return {
    width: 320,
    height: 180,
    data: context.getImageData(0, 0, 320, 180).data,
  };
}

/** Mean absolute per-channel difference of the pixel at byte offset `index`. */
function rgbDelta(left: PixelFrame, right: PixelFrame, index: number): number {
  return (
    (Math.abs((left.data[index] ?? 0) - (right.data[index] ?? 0)) +
      Math.abs((left.data[index + 1] ?? 0) - (right.data[index + 1] ?? 0)) +
      Math.abs((left.data[index + 2] ?? 0) - (right.data[index + 2] ?? 0))) /
    3
  );
}

/** Mean of the three colour channels of the pixel at byte offset `index`. */
function rgbMean(frame: PixelFrame, index: number): number {
  return (
    ((frame.data[index] ?? 0) +
      (frame.data[index + 1] ?? 0) +
      (frame.data[index + 2] ?? 0)) /
    3
  );
}

/** Pixels darker than this carry no usable relative signal. */
const NEAR_BLACK = 24;

interface DiffStats {
  /** Mean per-channel absolute difference (0-255). */
  mean: number;
  /** Brightness-weighted centroid of the difference, in thumbnail pixels. */
  x: number;
  y: number;
}

export function diffStats(left: PixelFrame, right: PixelFrame): DiffStats {
  let sum = 0;
  let mass = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const delta = rgbDelta(left, right, (y * left.width + x) * 4);
      sum += delta;
      mass += delta;
      weightedX += delta * x;
      weightedY += delta * y;
    }
  }
  const count = left.width * left.height;
  return {
    mean: count === 0 ? 0 : sum / count,
    x: mass === 0 ? 0 : weightedX / mass,
    y: mass === 0 ? 0 : weightedY / mass,
  };
}

/** Mean absolute RGB difference inside an annulus around `(cx, cy)`. */
export function annulusMeanDiff(
  left: PixelFrame,
  right: PixelFrame,
  cx: number,
  cy: number,
  minRadius: number,
  maxRadius: number,
): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance < minRadius || distance > maxRadius) continue;
      sum += rgbDelta(left, right, (y * left.width + x) * 4);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Mean relative luminance change inside a disc, ignoring near-black pixels.
 *
 * A radial darkness mask is a multiplicative scale, so the *relative* change
 * cancels the scene content: it is ~0 exactly where the authored mask is 0 and
 * ~`darkness` where the mask is 1.  That makes it a content-independent check
 * that the effect centre really is the design-pixel centre under the camera.
 */
export function centerClearance(
  left: PixelFrame,
  right: PixelFrame,
  cx: number,
  cy: number,
  maxRadius: number,
): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance > maxRadius) continue;
      const index = (y * left.width + x) * 4;
      const changed = rgbMean(left, index);
      const base = rgbMean(right, index);
      if (base < NEAR_BLACK) continue;
      sum += Math.abs(changed - base) / base;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

function luminanceAt(frame: PixelFrame, x: number, y: number): number {
  return rgbMean(frame, (y * frame.width + x) * 4);
}

/**
 * Mean horizontal+vertical gradient magnitude inside one annulus.
 *
 * Comparing the same ring before and after the blur isolates the high-
 * frequency energy the Gaussian removed.  Darkening cannot satisfy it, because
 * it scales a sharp ring and a blurred ring by the same mask.  Near-black
 * pixels are skipped so letterboxing cannot dilute the signal.
 */
export function edgeEnergy(
  frame: PixelFrame,
  cx: number,
  cy: number,
  minRadius: number,
  maxRadius: number,
): { energy: number; count: number } {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance < minRadius || distance > maxRadius) continue;
      const base = luminanceAt(frame, x, y);
      if (base < NEAR_BLACK) continue;
      const horizontal =
        x + 1 < frame.width ? Math.abs(luminanceAt(frame, x + 1, y) - base) : 0;
      const vertical =
        y + 1 < frame.height
          ? Math.abs(luminanceAt(frame, x, y + 1) - base)
          : 0;
      sum += horizontal + vertical;
      count += 1;
    }
  }
  return { energy: count === 0 ? 0 : sum / count, count };
}

/** Mean absolute RGB difference inside one disc. */
export function discMeanDiff(
  left: PixelFrame,
  right: PixelFrame,
  cx: number,
  cy: number,
  maxRadius: number,
): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      if (Math.hypot(x - cx, y - cy) > maxRadius) continue;
      sum += rgbDelta(left, right, (y * left.width + x) * 4);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** GLSL `smoothstep` in the same units as its edges. */
function smoothstepPx(edge0: number, edge1: number, value: number): number {
  const span = edge1 - edge0;
  const t = Math.min(1, Math.max(0, span <= 0 ? 1 : (value - edge0) / span));
  return t * t * (3 - 2 * t);
}

/**
 * Mean per-channel difference between a darken-only frame and the exact
 * `base * (1 - darkness * mask)` model.
 *
 * The zero-blur darkening path must be a single sample times the mask; a blur
 * that still ran (or a wrong mask) makes the periphery diverge from the model,
 * so the check covers the zero-blur bypass as well as the darkening value.
 */
export function darkenModelDiff(
  base: PixelFrame,
  darkened: PixelFrame,
  cx: number,
  cy: number,
  radiusPx: number,
  softnessPx: number,
  darkness: number,
): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < base.height; y += 1) {
    for (let x = 0; x < base.width; x += 1) {
      const mask = smoothstepPx(
        radiusPx,
        radiusPx + Math.max(softnessPx, 0.0001),
        Math.hypot(x - cx, y - cy),
      );
      const factor = 1 - darkness * mask;
      const index = (y * base.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const expected = (base.data[index + channel] ?? 0) * factor;
        sum += Math.abs((darkened.data[index + channel] ?? 0) - expected);
        count += 1;
      }
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** Coarse content-independent map of where a pass changed the frame. */
export function relativeChangeGrid(
  left: PixelFrame,
  right: PixelFrame,
  columns: number,
  rows: number,
): number[] {
  const grid: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.floor((column * left.width) / columns);
      const x1 = Math.floor(((column + 1) * left.width) / columns);
      const y0 = Math.floor((row * left.height) / rows);
      const y1 = Math.floor(((row + 1) * left.height) / rows);
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const index = (y * left.width + x) * 4;
          const changed = rgbMean(left, index);
          const base = rgbMean(right, index);
          if (base < NEAR_BLACK) continue;
          sum += Math.abs(changed - base) / base;
          count += 1;
        }
      }
      grid.push(count === 0 ? -1 : Math.round((sum / count) * 1000));
    }
  }
  return grid;
}

/**
 * Centroid of the lit pixels a pass left unchanged.
 *
 * `focus` darkens and blurs with the same radial mask, and the mask is exactly
 * zero inside `radius`, so the set of lit pixels whose relative change stays
 * below `threshold` *is* the sharp disc.  Its centroid is the pass centre
 * without depending on the scene content, which is what makes it a usable
 * screen/design-pixel anchoring assertion under a camera transform.
 */
export function unchangedCentroid(
  left: PixelFrame,
  right: PixelFrame,
  threshold = 0.02,
): { x: number; y: number; count: number; bounds: { x: number; y: number } } {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  let minX = left.width;
  let minY = left.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const index = (y * left.width + x) * 4;
      const changed = rgbMean(left, index);
      const base = rgbMean(right, index);
      if (base < NEAR_BLACK) continue;
      if (Math.abs(changed - base) / base >= threshold) continue;
      sumX += x;
      sumY += y;
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (count === 0) {
    return { x: -1, y: -1, count: 0, bounds: { x: -1, y: -1 } };
  }
  return {
    x: sumX / count,
    y: sumY / count,
    count,
    bounds: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  };
}
