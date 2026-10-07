// @vitest-environment node
/**
 * The KaTeX font URL map must not depend on which directory Vite treats as its
 * root: the game builds from the repository root, the editor from `editor/`.
 * The old root-relative `import.meta.glob("/node_modules/...")` produced an
 * empty map under \`editor/\` (and so "缺少 KaTeX 字体: KaTeX_AMS-Regular.woff2").
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { build, createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const fontsModule = path.join(here, "katexFonts.ts");
const roots = { game: repo, editor: path.join(repo, "editor") } as const;
const scratch = mkdtempSync(path.join(tmpdir(), "vectspace-katex-"));

const css = readFileSync(createRequire(import.meta.url).resolve("katex/dist/katex.min.css"), "utf8");
const names = [...new Set([...css.matchAll(/url\(fonts\/([^)]*\.woff2)\)/gu)].map((match) => match[1]!))];

const posix = (file: string): string => file.split(path.sep).join("/");

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.each(Object.entries(roots))("KaTeX font urls under the %s Vite root", (label, root) => {
  it("lists every woff2 the stylesheet references", () => {
    expect(names).toHaveLength(20);
    expect(names).toContain("KaTeX_AMS-Regular.woff2");
  });

  it("resolves and serves every font through the dev server", async () => {
    const server = await createServer({
      configFile: false, root, logLevel: "silent", appType: "custom", cacheDir: path.join(scratch, `dev-${label}`),
      server: { middlewareMode: true, ws: false, watch: null, fs: { allow: [repo] } },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      const mapping = await server.transformRequest(`/@fs/${posix(fontsModule)}`);
      expect(mapping?.code.match(/KaTeX_[\w-]+\.woff2/gu)?.length).toBeGreaterThanOrEqual(names.length * 2);
      for (const name of names) {
        const resolved = await server.pluginContainer.resolveId(`katex/dist/fonts/${name}?url`, fontsModule);
        expect(resolved?.id, name).toBeDefined();
        expect(existsSync(resolved!.id.split("?")[0]!), name).toBe(true);
        const served = await server.transformRequest(posix(resolved!.id).replace(/^(?=[A-Za-z]:)/u, "/@fs/"));
        expect(served?.code, name).toMatch(/export default "/u);
        expect(served?.code, name).toContain(name);
      }
    } finally {
      await server.close();
    }
  }, 60_000);

  it("emits or inlines every font in a production build", async () => {
    const entry = "virtual:katex-fonts-entry";
    const output = await build({
      configFile: false, root, logLevel: "silent", cacheDir: path.join(scratch, `build-${label}`),
      plugins: [{
        name: "katex-fonts-entry",
        resolveId: (id) => (id === entry ? `\0${entry}` : null),
        load: (id) => id === `\0${entry}`
          ? `import { KATEX_FONT_URLS } from ${JSON.stringify(posix(fontsModule))};\nglobalThis.urls = KATEX_FONT_URLS;`
          : null,
      }],
      build: { write: false, minify: false, outDir: path.join(scratch, `out-${label}`), rollupOptions: { input: entry } },
    });
    const items = (Array.isArray(output) ? output : [output as Exclude<typeof output, unknown[]>])
      .flatMap((result) => ("output" in result ? result.output : []));
    const emitted = items.filter((item) => item.type === "asset").map((item) => item.fileName);
    const chunk = items.find((item) => item.type === "chunk");
    expect(chunk?.type).toBe("chunk");
    const context = vm.createContext({});
    vm.runInContext((chunk as { code: string }).code, context);
    const mapped = Object.entries(vm.runInContext("urls", context) as Record<string, string>);
    expect(mapped.map(([name]) => name).sort()).toEqual([...names].sort());
    for (const [name, url] of mapped) {
      const emittedFile = emitted.find((file) => file.startsWith(`assets/${name.replace(".woff2", "")}-`) && file.endsWith(".woff2"));
      // Large fonts are emitted next to the page; assets under Vite's inline limit become data urls.
      expect(emittedFile !== undefined ? url.endsWith(emittedFile) : /^data:font\/woff2;base64,[A-Za-z0-9+/]+=*$/u.test(url), name).toBe(true);
    }
  }, 60_000);
});
