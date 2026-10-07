import { HTMLTextStyle, type HTMLTextSystem, type Texture } from "pixi.js";
import katexCss from "katex/dist/katex.min.css?raw";
import { KATEX_FONT_URLS } from "./katexFonts";
import { escapeMarkupHtml, renderStaticMarkup } from "./staticMarkup";

export interface TextBlockDefinition {
  schema_version: number;
  id: string;
  content: string;
  width: number;
  height: number;
  font?: string | null;
  font_size: number;
  line_height: number;
  color: string;
  align: "left" | "center" | "right";
  vertical_align: "top" | "center" | "bottom";
  padding: number;
  background?: string | null;
}

export interface TextBlockSource {
  definition: TextBlockDefinition;
  font_url?: string;
  /** Changes when a font is replaced at the same logical asset id. */
  font_version?: string;
}

export type TextBlockMap = Readonly<Record<string, TextBlockSource>>;

export function resolveTextBlocks(
  definitions: Readonly<Record<string, TextBlockDefinition>>,
  assets: Readonly<Record<string, string>>,
  defaultFont?: string | null,
  fontVersions: Readonly<Record<string, string>> = {},
): TextBlockMap {
  return Object.fromEntries(Object.entries(definitions).map(([id, definition]) => {
    const font = definition.font ?? defaultFont;
    const fontUrl = font == null ? undefined : assets[font];
    if (font != null && fontUrl === undefined) throw new Error(`固定文本块字体尚未解析: ${font}`);
    return [id, { definition, ...(fontUrl === undefined ? {} : { font_url: fontUrl, font_version: fontVersions[font!] ?? fontUrl }) }];
  }));
}
export const MAX_TEXT_BLOCK_PIXELS = 4_194_304;
export const MAX_TEXT_BLOCK_LENGTH = 16_384;
const RESOURCE_TIMEOUT_MS = 8_000;
const MAX_FONT_BYTES = 16_777_216;

export function textBlockVersion(source: TextBlockSource, resolution = 1): string {
  return JSON.stringify([source.definition, source.font_url ?? "", source.font_version ?? "", resolution]);
}

export function validateTextBlock(definition: TextBlockDefinition): void {
  const { width, height, font_size, line_height, padding } = definition;
  if (![width, height, font_size, line_height, padding].every(Number.isFinite)
    || width < 1 || height < 1 || width > 4096 || height > 4096
    || width * height > MAX_TEXT_BLOCK_PIXELS
    || font_size < 1 || font_size > 512 || line_height < 0.5 || line_height > 8
    || padding < 0 || padding * 2 >= Math.min(width, height)
    || definition.content.length > MAX_TEXT_BLOCK_LENGTH
    || !/^#[\da-f]{6}(?:[\da-f]{2})?$/iu.test(definition.color)
    || (definition.background != null && !/^#[\da-f]{6}(?:[\da-f]{2})?$/iu.test(definition.background))
    || !["left", "center", "right"].includes(definition.align)
    || !["top", "center", "bottom"].includes(definition.vertical_align)) {
    throw new Error(`固定文本块参数无效: ${definition.id}`);
  }
}

async function fontData(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOURCE_TIMEOUT_MS);
  let bytes: Uint8Array;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`字体加载失败: ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (declared > MAX_FONT_BYTES) throw new Error("字体超过 16 MiB");
    // Enforce the budget while streaming; an unbounded body is never buffered.
    const reader = response.body?.getReader();
    if (reader === undefined) {
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FONT_BYTES) {
          await reader.cancel();
          throw new Error("字体超过 16 MiB");
        }
        chunks.push(value);
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (bytes.length > MAX_FONT_BYTES) throw new Error("字体超过 16 MiB");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:application/octet-stream;base64,${btoa(binary)}`;
}

/**
 * Bytes of a bundled KaTeX font as an embeddable data URL.
 *
 * A production build inlines assets under Vite's `assetsInlineLimit` (KaTeX's
 * Size3 face) as `data:` URLs.  Those bytes are already in hand; fetching them
 * would be a `connect-src` request that the Tauri CSP does not allow.
 */
async function bundledFontData(url: string): Promise<string> {
  if (!url.startsWith("data:")) return fontData(url);
  const inline = /^data:[^,;]*;base64,([A-Za-z0-9+/]*={0,2})$/u.exec(url);
  if (inline === null) throw new Error("KaTeX 字体 data URL 无效");
  if (inline[1]!.length * 3 / 4 > MAX_FONT_BYTES) throw new Error("字体超过 16 MiB");
  return `data:application/octet-stream;base64,${inline[1]}`;
}

/** Local CSS and embedded fonts, not author supplied HTML or CSS. */
export class TextBlockRasterizer {
  readonly #fontCss = new Map<string, Promise<string>>();
  readonly #owned = new Map<Texture, Promise<Texture>>();
  #katexCss: Promise<string> | undefined;
  #disposed = false;

  constructor(readonly system: Pick<HTMLTextSystem, "getTexturePromise" | "returnTexturePromise">) {}

  async html(source: TextBlockSource): Promise<string> {
    validateTextBlock(source.definition);
    const definition = source.definition;
    // A failure is reported to every waiting caller but never cached, so a
    // later call can recover once the fonts are reachable again.
    const katex = this.#katexCss ??= this.#embedKatexFonts().catch((error: unknown) => {
      this.#katexCss = undefined;
      throw error;
    });
    let projectFont: Promise<string> = Promise.resolve("");
    if (source.font_url !== undefined) {
      const key = `${source.font_url}\0${source.font_version ?? ""}`;
      let css = this.#fontCss.get(key);
      if (css === undefined) {
        css = fontData(source.font_url).then(async (data) => {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
          const name = `vs_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          return `@font-face{font-family:${name};src:url('${data}');font-weight:normal;font-style:normal}`;
        }).catch((error: unknown) => { this.#fontCss.delete(key); throw error; });
        this.#fontCss.set(key, css);
      }
      projectFont = css;
    }
    // Both font loads are already running; awaiting them together observes a
    // rejection of either one immediately instead of after the other settles.
    const [katexStyle, projectFontCss] = await Promise.all([katex, projectFont]);
    const family = /font-family:([^;]+)/u.exec(projectFontCss)?.[1] ?? "sans-serif";
    const justify = { top: "flex-start", center: "center", bottom: "flex-end" }[definition.vertical_align];
    const style = `box-sizing:border-box;width:${definition.width}px;height:${definition.height}px;overflow:hidden;padding:${definition.padding}px;display:flex;flex-direction:column;justify-content:${justify};background:${definition.background ?? "transparent"};color:${definition.color};font-family:${family};font-size:${definition.font_size}px;line-height:${definition.line_height};text-align:${definition.align};white-space:normal;overflow-wrap:anywhere`;
    return `<style>${katexStyle}${projectFontCss}</style><div class="vs-text-block" style="${escapeMarkupHtml(style)}"><div style="flex-shrink:0;color:inherit;font-family:inherit;font-size:inherit;line-height:inherit;text-align:inherit">${renderStaticMarkup(definition.content)}</div></div>`;
  }

  async create(source: TextBlockSource, resolution = 1): Promise<Texture> {
    if (this.#disposed) throw new Error("文本纹理生成器已释放");
    if (!Number.isFinite(resolution) || resolution <= 0 || resolution > 2
      || source.definition.width * source.definition.height * resolution ** 2 > MAX_TEXT_BLOCK_PIXELS) {
      throw new Error("固定文本块纹理超过像素预算");
    }
    const html = await this.html(source);
    if (this.#disposed) throw new Error("文本纹理生成器已释放");
    const promise = this.system.getTexturePromise({
      text: html,
      style: new HTMLTextStyle({ fontFamily: "sans-serif", fontSize: source.definition.font_size, fill: source.definition.color, padding: 0 }),
      resolution,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const texture = await Promise.race([promise, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("固定文本块生成超时")), RESOURCE_TIMEOUT_MS);
      })]);
      if (this.#disposed) throw new Error("文本纹理生成器已释放");
      this.#owned.set(texture, promise);
      return texture;
    } catch (error) {
      // Even a late successful rasterization goes back to Pixi's pool once.
      this.system.returnTexturePromise(promise);
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  release(texture: Texture): void {
    const promise = this.#owned.get(texture);
    if (promise === undefined) return;
    this.#owned.delete(texture);
    this.system.returnTexturePromise(promise);
  }

  destroy(): void {
    this.#disposed = true;
    for (const texture of this.#owned.keys()) this.release(texture);
    this.#fontCss.clear();
  }

  async #embedKatexFonts(): Promise<string> {
    // KaTeX lists woff2/woff/ttf alternatives. Embed only the first local woff2.
    const replacements = new Map<string, string>();
    const names = [...katexCss.matchAll(/url\(fonts\/([^)]*\.woff2)\) format\("woff2"\)(?:,url\([^)]*\) format\("(?:woff|truetype)"\))*/gu)];
    await Promise.all(names.map(async ([css, name]) => {
      const url = KATEX_FONT_URLS[name!];
      if (url === undefined) throw new Error(`缺少 KaTeX 字体: ${name}`);
      replacements.set(css, `url('${await bundledFontData(url)}') format('woff2')`);
    }));
    let embedded = katexCss;
    for (const [css, replacement] of replacements) embedded = embedded.split(css).join(replacement);
    if (/url\((?!['"]?data:)/u.test(embedded)) throw new Error("KaTeX 字体未完全嵌入");
    return embedded;
  }
}
