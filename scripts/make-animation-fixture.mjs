/**
 * Generates the small loop-animation fixture images used by the presentation
 * showcase scene.
 *
 * The milestone requires every frame of one animation to share a pixel size,
 * and none of the copied demo art happens to have two same-size variants.
 * Generating them keeps the fixture reproducible and dependency free: this
 * script writes plain RGBA PNGs with Node's own zlib, so no image library is
 * needed to regenerate or review the fixture.
 *
 *   node scripts/make-animation-fixture.mjs
 */
/* global Buffer, console */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** `paint(x, y)` returns `[r, g, b, a]` with 0-255 components. */
function png(width, height, paint) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    raw[cursor] = 0; // filter: none
    cursor += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      raw[cursor] = r;
      raw[cursor + 1] = g;
      raw[cursor + 2] = b;
      raw[cursor + 3] = a;
      cursor += 4;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function write(relative, bytes) {
  const path = resolve(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`wrote ${relative} (${bytes.length} bytes)`);
}

/** A framed panel whose accent bar pulses between the A and B frames. */
function panel(width, height, accent, border) {
  return png(width, height, (x, y) => {
    const margin = 6;
    const inside =
      x >= margin && y >= margin && x < width - margin && y < height - margin;
    const borderBand =
      x < margin || y < margin || x >= width - margin || y >= height - margin;
    if (borderBand) return border;
    const barHeight = Math.round(height * 0.08);
    const inBar = y >= height - margin - barHeight;
    if (inBar) return accent;
    return inside ? [14, 18, 32, 235] : [0, 0, 0, 0];
  });
}

/** A moving highlight band, so a frame change is visible at a glance. */
function scanner(width, height, offset) {
  return png(width, height, (x, y) => {
    const position = (x + offset) % Math.round(width / 2);
    const lit = position < 24;
    const shade = 8 + Math.round((y / height) * 10);
    if (!lit) return [shade, shade + 2, shade + 12, 255];
    return [96, 210, 255, 255];
  });
}

write(
  "game/assets/gui/anim_dialogue_pulse_a.png",
  panel(1920, 387, [58, 142, 214, 255], [22, 28, 48, 255]),
);
write(
  "game/assets/gui/anim_dialogue_pulse_b.png",
  panel(1920, 387, [96, 210, 255, 255], [22, 28, 48, 255]),
);
write(
  "game/assets/gui/anim_button_pulse_a.png",
  panel(200, 80, [58, 142, 214, 255], [120, 132, 160, 255]),
);
write(
  "game/assets/gui/anim_button_pulse_b.png",
  panel(200, 80, [96, 210, 255, 255], [120, 132, 160, 255]),
);
write("game/assets/backgrounds/anim_scan_a.png", scanner(1920, 1080, 0));
write("game/assets/backgrounds/anim_scan_b.png", scanner(1920, 1080, 240));
