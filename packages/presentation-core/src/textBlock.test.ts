// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Texture } from "pixi.js";
import { TextBlockRasterizer } from "./textBlock";
import { TEXT_FIXTURE } from "./visualTestKit";

// Vitest answers every css import, `?raw` included, with an empty string, which would make the
// embedding step a no-op.  Serve the real stylesheet instead so the real font list is exercised.
const fonts = await vi.hoisted(async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const css = readFileSync(createRequire(import.meta.url).resolve("katex/dist/katex.min.css"), "utf8");
  // The real URL map, with entries a test can replace for one case.
  return { css, map: {} as Record<string, string>, original: {} as Record<string, string> };
});
vi.mock("katex/dist/katex.min.css?raw", () => ({ default: fonts.css }));
vi.mock("./katexFonts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./katexFonts")>();
  fonts.original = { ...actual.KATEX_FONT_URLS };
  fonts.map = { ...actual.KATEX_FONT_URLS };
  return { KATEX_FONT_URLS: fonts.map };
});

const MATH = { ...TEXT_FIXTURE, content: "公式 $\\mathbb{R}$ 与 $x^2 + \\sqrt{y}$" };
const system = { getTexturePromise: vi.fn(), returnTexturePromise: vi.fn() };

function referencedFonts(): string[] {
  return [...new Set([...fonts.css.matchAll(/url\(fonts\/([^)]*\.woff2)\)/gu)].map((match) => match[1]!))];
}

function stubFetch(handler: (url: string) => Response): ReturnType<typeof vi.fn> {
  const fetcher = vi.fn((url: string) => Promise.resolve(handler(url)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => {
  Object.assign(fonts.map, fonts.original);
  for (const name of Object.keys(fonts.map)) if (!(name in fonts.original)) delete fonts.map[name];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TextBlockRasterizer KaTeX fonts", () => {
  it("maps every woff2 the KaTeX stylesheet references, including KaTeX_AMS-Regular", () => {
    const names = referencedFonts();
    expect(names).toContain("KaTeX_AMS-Regular.woff2");
    expect(names.filter((name) => !fonts.original[name])).toEqual([]);
    expect(Object.keys(fonts.original).sort()).toEqual([...names].sort());
  });

  it("embeds every font into the stylesheet without leaving an external url", async () => {
    const fetcher = stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    const html = await new TextBlockRasterizer(system).html({ definition: MATH });
    expect(fetcher.mock.calls.map(([url]) => url as string).sort()).toEqual(Object.values(fonts.original).sort());
    expect(html).toContain("katex");
    expect(html).not.toMatch(/url\((?!['"]?data:)/u);
    expect(html.match(/url\('data:application\/octet-stream;base64,AQID'\) format\('woff2'\)/gu)).toHaveLength(referencedFonts().length);
    expect(html).not.toContain("url(fonts/");
  });

  it("embeds a font that a production build inlined as a data url without fetching it", async () => {
    // Vite inlines assets under its inline limit (KaTeX_Size3-Regular.woff2); the Tauri CSP forbids fetching data: urls.
    fonts.map["KaTeX_Size3-Regular.woff2"] = "data:font/woff2;base64,CgsM";
    const fetcher = stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    const html = await new TextBlockRasterizer(system).html({ definition: MATH });
    expect(fetcher).toHaveBeenCalledTimes(referencedFonts().length - 1);
    expect(fetcher.mock.calls.some(([url]) => (url as string).startsWith("data:"))).toBe(false);
    expect(html).toContain("url('data:application/octet-stream;base64,CgsM') format('woff2')");
  });

  it("rejects an invalid or oversize inlined font instead of embedding it", async () => {
    stubFetch(() => new Response(new Uint8Array([1])));
    fonts.map["KaTeX_Size3-Regular.woff2"] = "data:font/woff2,not-base64";
    await expect(new TextBlockRasterizer(system).html({ definition: MATH })).rejects.toThrow("data URL 无效");
    fonts.map["KaTeX_Size3-Regular.woff2"] = `data:font/woff2;base64,${"A".repeat(Math.ceil(16_777_216 * 4 / 3) + 8)}`;
    await expect(new TextBlockRasterizer(system).html({ definition: MATH })).rejects.toThrow("16 MiB");
  });

  it("reports a missing font by name and recovers once it is mapped", async () => {
    stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    delete fonts.map["KaTeX_AMS-Regular.woff2"];
    const rasterizer = new TextBlockRasterizer(system);
    await expect(rasterizer.html({ definition: MATH })).rejects.toThrow("缺少 KaTeX 字体: KaTeX_AMS-Regular.woff2");
    // The failure is not cached on the rasterizer: the same instance succeeds after the fix.
    fonts.map["KaTeX_AMS-Regular.woff2"] = fonts.original["KaTeX_AMS-Regular.woff2"]!;
    await expect(rasterizer.html({ definition: MATH })).resolves.toContain("data:application/octet-stream;base64,AQID");
  });

  it("keeps a real font failure explicit, then retries instead of replaying the cached rejection", async () => {
    let fail = true;
    const fetcher = stubFetch(() => fail ? new Response("nope", { status: 404 }) : new Response(new Uint8Array([1, 2, 3])));
    const rasterizer = new TextBlockRasterizer(system);
    await expect(rasterizer.html({ definition: MATH })).rejects.toThrow("字体加载失败: 404");
    const failed = fetcher.mock.calls.length;
    fail = false;
    await expect(rasterizer.html({ definition: MATH })).resolves.toContain("katex");
    expect(fetcher.mock.calls.length).toBeGreaterThan(failed);
    // Resolved once: further calls reuse the embedded stylesheet.
    const resolved = fetcher.mock.calls.length;
    await rasterizer.html({ definition: MATH });
    expect(fetcher.mock.calls.length).toBe(resolved);
  });

  it("surfaces a KaTeX font failure without waiting for a slow project font", async () => {
    let finish!: () => void;
    const slow = new Promise<Response>((resolve) => { finish = () => resolve(new Response("late", { status: 404 })); });
    const fetcher = vi.fn((url: string) => url === "font://slow" ? slow : Promise.resolve(new Response("nope", { status: 404 })));
    vi.stubGlobal("fetch", fetcher);
    const rasterizer = new TextBlockRasterizer(system);
    // Both loads start together; the KaTeX rejection must not sit unobserved behind the project font.
    await expect(rasterizer.html({ definition: MATH, font_url: "font://slow", font_version: "1" })).rejects.toThrow("字体加载失败: 404");
    expect(fetcher).toHaveBeenCalledWith("font://slow", expect.anything());
    finish();
    await slow;
    // The failure is not cached, so the same instance retries once the fonts load.
    stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    await expect(rasterizer.html({ definition: MATH })).resolves.toContain("data:application/octet-stream;base64,AQID");
  });

  it("rejects a stylesheet that would still reference an external url", async () => {
    vi.resetModules();
    vi.doMock("katex/dist/katex.min.css?raw", () => ({
      default: "@font-face{font-family:KaTeX_Evil;src:url(https://example.invalid/evil.woff2) format('woff2')}",
    }));
    try {
      const { TextBlockRasterizer: Fresh } = await import("./textBlock");
      stubFetch(() => new Response(new Uint8Array([1])));
      await expect(new Fresh(system).html({ definition: MATH })).rejects.toThrow("KaTeX 字体未完全嵌入");
    } finally {
      vi.doUnmock("katex/dist/katex.min.css?raw");
      vi.resetModules();
    }
  });
});

describe("TextBlockRasterizer resource limits", () => {
  it("rejects an oversize project font while streaming instead of buffering the whole body", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "font://big"
      ? new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(chunk); } }))
      : new Response(new Uint8Array([0, 1, 2])))));
    try {
      const rasterizer = new TextBlockRasterizer({ getTexturePromise: vi.fn(), returnTexturePromise: vi.fn() });
      await expect(rasterizer.html({ definition: TEXT_FIXTURE, font_url: "font://big", font_version: "1" }))
        .rejects.toThrow("16 MiB");
      expect(pulls).toBeLessThan(24);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns a late pooled texture after disposal rather than committing or destroying its source", async () => {
    vi.spyOn(TextBlockRasterizer.prototype, "html").mockResolvedValue("<div>safe</div>");
    let resolve!: (texture: Texture) => void;
    const pending = new Promise<Texture>((done) => { resolve = done; });
    const returned = vi.fn();
    const rasterizer = new TextBlockRasterizer({ getTexturePromise: () => pending, returnTexturePromise: returned });
    const created = rasterizer.create({ definition: TEXT_FIXTURE });
    await Promise.resolve();
    rasterizer.destroy();
    const texture = { destroy: vi.fn() } as unknown as Texture;
    resolve(texture);
    await expect(created).rejects.toThrow("已释放");
    expect(returned).toHaveBeenCalledExactlyOnceWith(pending);
    expect(texture.destroy).not.toHaveBeenCalled();
  });
});
