/**
 * Generates the pencil-and-sketch-paper UI art.
 *
 * Every asset is drawn procedurally (no image model): the drawing code in
 * `scripts/sketch-ui/assets/*.mjs` emits an SVG per asset, seeded from the asset
 * name, so regenerating is deterministic.  PNGs are rasterised with headless
 * Edge/Chrome (the game only loads PNG/JPEG/GIF/WebP, not SVG).
 *
 *   node scripts/generate-sketch-ui.mjs                 SVG only
 *   node scripts/generate-sketch-ui.mjs --png           SVG + PNG (skips fresh PNGs)
 *   node scripts/generate-sketch-ui.mjs --png --force   re-render every PNG
 *   node scripts/generate-sketch-ui.mjs --only dialogue SVG for names matching a regex
 *   node scripts/generate-sketch-ui.mjs --png --sheets  also render contact sheets
 *   node scripts/generate-sketch-ui.mjs --file hud      load only assets/hud.mjs (comma list)
 *
 * Sheet options: `--sheet-group <dir>` one group only, `--zoom` larger cells,
 * `--guides` outline each asset's `textBox` (magenta) and `slice` (cyan),
 * `--svg-sheets` show the SVGs instead of the PNGs.  `--jobs N` browser count.
 *
 * Output:
 *   art/ui-sketch/svg/<group>/<name>.svg       editable sources
 *   game/assets/sketch/<group>/<name>.png      game-ready images
 *   art/ui-sketch/manifest-assets.yaml         `assets:` entries to paste into manifest.yaml
 *   art/ui-sketch/catalog.json                 sizes, text boxes and slice insets per asset
 *   art/ui-sketch/sheets/<group>.png           contact sheets for review (--sheets)
 *
 * The manifest snippet and catalog are only written on a full run (no
 * `--only` / `--file`).
 */
/* global clearTimeout, console, process, setTimeout */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Canvas } from "./sketch-ui/canvas.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svgRoot = join(root, "art", "ui-sketch", "svg");
const pngRoot = join(root, "game", "assets", "sketch");
const sheetRoot = join(root, "art", "ui-sketch", "sheets");
const manifestPath = join(root, "art", "ui-sketch", "manifest-assets.yaml");
const catalogPath = join(root, "art", "ui-sketch", "catalog.json");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const onlyPattern = option("only") ? new RegExp(option("only")) : null;
const onlyFiles = option("file")
  ? option("file")
      .split(",")
      .map((name) => `${name.replace(/\.mjs$/, "")}.mjs`)
  : null;
const partial = Boolean(onlyPattern || onlyFiles);

/** `[x, y, w, h]` or `[top, right, bottom, left]`: four finite numbers. */
const isBox = (value) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((n) => Number.isFinite(n));

async function loadAssets() {
  const dir = join(root, "scripts", "sketch-ui", "assets");
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".mjs"))
    .filter((file) => !onlyFiles || onlyFiles.includes(file))
    .sort();
  if (onlyFiles) {
    for (const file of onlyFiles) {
      if (!files.includes(file))
        throw new Error(`--file: no scripts/sketch-ui/assets/${file}`);
    }
  }
  const assets = [];
  for (const file of files) {
    const module = await import(pathToFileURL(join(dir, file)).href);
    for (const asset of module.assets) assets.push({ ...asset, source: file });
  }
  const seen = new Set();
  for (const asset of assets) {
    if (!/^[a-z0-9_]+$/.test(asset.name))
      throw new Error(`asset name ${asset.name} must match [a-z0-9_]+`);
    if (!/^[a-z0-9_]+$/.test(asset.dir))
      throw new Error(`asset ${asset.name}: dir must match [a-z0-9_]+`);
    if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height))
      throw new Error(`asset ${asset.name}: width/height must be integers`);
    if (seen.has(asset.name))
      throw new Error(`duplicate asset name ${asset.name}`);
    if (asset.textBox !== undefined && !isBox(asset.textBox))
      throw new Error(`asset ${asset.name}: textBox must be [x, y, w, h]`);
    if (asset.slice !== undefined && !isBox(asset.slice))
      throw new Error(
        `asset ${asset.name}: slice must be [top, right, bottom, left]`,
      );
    seen.add(asset.name);
  }
  return assets;
}

function buildSvg(asset) {
  const canvas = new Canvas(
    asset.name,
    asset.width,
    asset.height,
    asset.seed ?? asset.name,
  );
  asset.draw(canvas);
  return canvas.svg();
}

function writeIfChanged(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}

function findBrowser() {
  const candidates = [
    process.env.VECTSPACE_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found)
    throw new Error(
      "no Edge/Chrome found; set VECTSPACE_BROWSER to a Chromium executable",
    );
  return found;
}

function pngSize(path) {
  const bytes = readFileSync(path);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

// One browser profile per process and slot, so concurrent runs never share a lock.
const profileDirs = new Set();
const profileDir = (slot) => {
  const dir = join(
    tmpdir(),
    `vectspace-sketch-${String(process.pid)}-${String(slot)}`,
  );
  profileDirs.add(dir);
  return dir;
};

/** Screenshot `url` into `out` at exactly `width` x `height` with a transparent page. */
function screenshot(browser, slot, url, out, width, height) {
  return new Promise((done, fail) => {
    mkdirSync(dirname(out), { recursive: true });
    const child = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--default-background-color=00000000",
        "--no-first-run",
        `--user-data-dir=${profileDir(slot)}`,
        `--window-size=${String(width)},${String(height)}`,
        `--screenshot=${out}`,
        url,
      ],
      { stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`timed out rendering ${out}`));
    }, 120000);
    child.on("exit", () => {
      clearTimeout(timer);
      if (!existsSync(out))
        return fail(new Error(`browser produced no file for ${out}`));
      const [w, h] = pngSize(out);
      if (w !== width || h !== height)
        return fail(
          new Error(
            `${out}: rendered ${String(w)}x${String(h)}, expected ${String(width)}x${String(height)}`,
          ),
        );
      done();
    });
    child.on("error", fail);
  });
}

async function pool(items, size, task) {
  let cursor = 0;
  const errors = [];
  await Promise.all(
    Array.from({ length: size }, async (_, slot) => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        try {
          await task(item, slot);
        } catch (error) {
          errors.push(error);
        }
      }
    }),
  );
  return errors;
}

function mtime(path) {
  return existsSync(path) ? statSync(path).mtimeMs : 0;
}

const svgPath = (asset) => join(svgRoot, asset.dir, `${asset.name}.svg`);
const pngPath = (asset) => join(pngRoot, asset.dir, `${asset.name}.png`);

function manifestYaml(assets) {
  const lines = [
    "# Generated by scripts/generate-sketch-ui.mjs - do not edit.",
    "# Paste under `assets:` in game/manifest.yaml to use the sketch UI art.",
  ];
  for (const asset of [...assets].sort((a, b) =>
    `${a.dir}/${a.name}`.localeCompare(`${b.dir}/${b.name}`),
  )) {
    lines.push(
      `  ${asset.kind ?? "gui"}.sketch_${asset.name}:`,
      `    kind: ${asset.kind ?? "gui"}`,
      `    path: sketch/${asset.dir}/${asset.name}.png`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Layout facts the UI needs when it adopts an image (see README). */
function catalogJson(assets) {
  const entries = [...assets]
    .sort((a, b) => `${a.dir}/${a.name}`.localeCompare(`${b.dir}/${b.name}`))
    .map((asset) => ({
      id: `${asset.kind ?? "gui"}.sketch_${asset.name}`,
      path: `sketch/${asset.dir}/${asset.name}.png`,
      size: [asset.width, asset.height],
      ...(asset.textBox ? { textBox: asset.textBox } : {}),
      ...(asset.slice ? { slice: asset.slice } : {}),
      ...(asset.note ? { note: asset.note } : {}),
    }));
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/** Dashed overlays for `--guides`, in the cell's scaled coordinates. */
function guideBoxes(asset, scale) {
  const out = [];
  const box = (x, y, w, h, color) =>
    `<i style="left:${String(Math.round(x * scale))}px;top:${String(Math.round(y * scale))}px;width:${String(Math.round(w * scale))}px;height:${String(Math.round(h * scale))}px;border-color:${color}"></i>`;
  if (asset.textBox) out.push(box(...asset.textBox, "#ff2bd6"));
  if (asset.slice) {
    const [top, right, bottom, left] = asset.slice;
    out.push(
      box(
        left,
        top,
        asset.width - left - right,
        asset.height - top - bottom,
        "#2be4ff",
      ),
    );
  }
  return out.join("");
}

/** One contact-sheet HTML per group; returns `{ html, width, height }`. */
function sheetHtml(group, assets, { useSvg, zoom, guides }) {
  const sheetW = 1800;
  const cellMaxW = zoom ? 1760 : 860;
  const cellMaxH = zoom ? 2400 : 520;
  const pad = 18;
  let x = pad;
  let y = pad;
  let rowH = 0;
  const cells = [];
  for (const asset of assets) {
    const scale = Math.min(1, cellMaxW / asset.width, cellMaxH / asset.height);
    const w = Math.round(asset.width * scale);
    const h = Math.round(asset.height * scale);
    const cellW = Math.max(w, 150);
    if (x + cellW + pad > sheetW && x > pad) {
      x = pad;
      y += rowH + pad;
      rowH = 0;
    }
    const src = useSvg ? svgPath(asset) : pngPath(asset);
    cells.push(
      `<figure style="left:${String(x)}px;top:${String(y)}px;width:${String(cellW)}px"><img src="${pathToFileURL(src).href}" width="${String(w)}" height="${String(h)}">${guides ? guideBoxes(asset, scale) : ""}<figcaption>${asset.name}<br>${String(asset.width)}x${String(asset.height)}${scale < 1 ? ` @${String(Math.round(scale * 100))}%` : ""}</figcaption></figure>`,
    );
    x += cellW + pad;
    rowH = Math.max(rowH, h + 34);
  }
  const height = y + rowH + pad;
  const html =
    `<!doctype html><meta charset="utf-8"><style>` +
    `html,body{margin:0;background:#5b6370}figure{position:absolute;margin:0}` +
    `img{display:block;background:repeating-conic-gradient(#6b7380 0% 25%,#5b6370 0% 50%) 0 0/20px 20px}` +
    `figcaption{font:12px/1.3 Consolas,monospace;color:#e8ecf2;margin-top:4px}` +
    `i{position:absolute;box-sizing:border-box;border:2px dashed}</style>` +
    `<body style="width:${String(sheetW)}px;height:${String(height)}px">${cells.join("")}</body>`;
  return { html, width: sheetW, height, title: group };
}

async function main() {
  const all = await loadAssets();
  const selected = onlyPattern
    ? all.filter((asset) => onlyPattern.test(asset.name))
    : all;
  if (!selected.length) throw new Error("no asset matches --only / --file");

  let rewritten = 0;
  for (const asset of selected) {
    const text = buildSvg(asset);
    if (writeIfChanged(svgPath(asset), text)) rewritten += 1;
  }
  console.log(
    `svg: ${String(selected.length)} assets (${String(rewritten)} written)`,
  );

  if (!partial) {
    writeIfChanged(manifestPath, manifestYaml(all));
    writeIfChanged(catalogPath, catalogJson(all));
  }

  const wantPng = flag("png") || flag("sheets");
  if (wantPng) {
    const browser = findBrowser();
    const stale = selected.filter(
      (asset) => flag("force") || mtime(pngPath(asset)) < mtime(svgPath(asset)),
    );
    let done = 0;
    const errors = await pool(
      stale,
      Number(option("jobs") ?? 4),
      async (asset, slot) => {
        await screenshot(
          browser,
          slot,
          pathToFileURL(svgPath(asset)).href,
          pngPath(asset),
          asset.width,
          asset.height,
        );
        done += 1;
        if (done % 10 === 0 || done === stale.length)
          console.log(`png: ${String(done)}/${String(stale.length)}`);
      },
    );
    if (!stale.length) console.log("png: all up to date");
    for (const error of errors) console.error(error.message);
    if (errors.length) process.exitCode = 1;

    if (flag("sheets")) {
      const groups = new Map();
      for (const asset of selected)
        groups.set(asset.dir, [...(groups.get(asset.dir) ?? []), asset]);
      // `--sheet-group dir` limits sheets to one group (and --only to some assets).
      const sheets = [...groups.entries()].filter(
        ([group]) => !option("sheet-group") || group === option("sheet-group"),
      );
      await pool(sheets, 2, async ([group, members], slot) => {
        const sheet = sheetHtml(group, members, {
          useSvg: flag("svg-sheets"),
          zoom: flag("zoom"),
          guides: flag("guides"),
        });
        const suffix = flag("zoom") ? "_zoom" : "";
        const htmlPath = join(sheetRoot, `${group}${suffix}.html`);
        writeIfChanged(htmlPath, sheet.html);
        await screenshot(
          browser,
          10 + slot,
          pathToFileURL(htmlPath).href,
          join(sheetRoot, `${group}${suffix}.png`),
          sheet.width,
          sheet.height,
        );
      });
      console.log(`sheets: ${sheetRoot}`);
    }
  }
  console.log(`assets: ${basename(svgRoot)} -> ${svgRoot}`);
}

try {
  await main();
} finally {
  for (const dir of profileDirs) rmSync(dir, { recursive: true, force: true });
}
