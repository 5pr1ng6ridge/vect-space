import "pixi.js/unsafe-eval";
import { Application, ParticleContainer, Rectangle, Sprite, type Container } from "pixi.js";
import type { ParticleDefinition } from "../packages/presentation-core/src/particles";
import { TextBlockRasterizer, type TextBlockDefinition } from "../packages/presentation-core/src/textBlock";
import { SceneSurface, pixiSceneKit, type SceneApplicationLike } from "../packages/presentation-core/src/sceneSurface";
import { spritePreset } from "../packages/presentation-core/src/visual";

async function probe() {
  console.info("Visual gate: raw Pixi text");
  const application = new Application();
  await application.init({
    canvas: document.querySelector<HTMLCanvasElement>("#probe")!,
    width: 960, height: 540, autoStart: false, preference: "webgl",
    backgroundAlpha: 0, preserveDrawingBuffer: true,
  });
  const rasterizer = new TextBlockRasterizer(application.renderer.htmlText);
  const definition: TextBlockDefinition = {
    schema_version: 2, id: "probe", content: "固定文本：中文 & <script>\n行内公式 $x^2+\\frac{1}{2}$\n$$\\int_0^1 x^2 dx=\\frac{1}{3}$$\n末行内容\n越界内容不应显示\n越界内容不应显示",
    width: 720, height: 240, font_size: 36, line_height: 1.3,
    align: "left", vertical_align: "top", padding: 16, color: "#FFFFFF",
  };
  const started = performance.now();
  const texture = await rasterizer.create({ definition, font_url: "/game/assets/fonts/fusion-pixel-12px-monospaced-zh_hans.ttf" });
  const sprite = new Sprite(texture);
  sprite.position.set(40, 40);
  application.stage.addChild(sprite);
  application.render();
  const canvas = application.renderer.extract.canvas({ target: application.stage, frame: application.screen }) as HTMLCanvasElement;
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0, outside = 0;
  const rows = [0, 0, 0];
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const alpha = pixels[(y * canvas.width + x) * 4 + 3]!;
      if (alpha < 32 || pixels[(y * canvas.width + x) * 4]! < 32) continue;
      ink += 1;
      if (x < 40 || y < 40 || x >= 760 || y >= 280) outside += 1;
      if (y >= 56 && y < 106) rows[0]! += 1;
      if (y >= 106 && y < 166) rows[1]! += 1;
      if (y >= 166 && y < 260) rows[2]! += 1;
    }
  }
  const initialScreenshot = canvas.toDataURL("image/png");
  const report = { renderer: application.renderer.name, width: texture.width, height: texture.height, ink, outside, rows, elapsed_ms: performance.now() - started };
  if (texture.width !== definition.width || texture.height !== definition.height || ink < 2000 || outside > 0 || rows.some((value) => value < 200)) {
    throw new Error(`Text texture gate failed: ${JSON.stringify(report)}`);
  }
  // A transformed instance uses the same texture, not a second text layout.
  sprite.rotation = 0.12;
  sprite.scale.set(0.9);
  application.render();
  const thumbnail = application.renderer.extract.canvas({ target: application.stage, frame: application.screen }) as HTMLCanvasElement;
  const transformedPixels = thumbnail.getContext("2d")!.getImageData(0, 0, thumbnail.width, thumbnail.height).data;
  const transformedInk = Array.from(transformedPixels).filter((value, index) => index % 4 === 3 && value > 32).length;
  if (transformedInk < 1500) throw new Error(`Transformed text vanished: ${transformedInk}`);
  const screenshot = initialScreenshot;
  sprite.destroy();
  rasterizer.release(texture);
  rasterizer.release(texture);
  rasterizer.destroy();
  application.destroy({ removeView: false }, { children: true });
  const surfaceReport = await probeSurface(definition);
  const sampling = await probeParticleSampling();
  const particles = await probeParticles();
  return { ...report, ...surfaceReport, sampling, particles, screenshot };
}

/** The same tiny PNG must stay crisp as particles without changing Sprite sampling. */
async function probeParticleSampling() {
  const image = document.createElement("canvas");
  image.width = 2;
  image.height = 2;
  const context = image.getContext("2d")!;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, 1, 2);
  context.fillStyle = "#FFFFFF";
  context.fillRect(1, 0, 1, 2);
  const assets = { pixel: image.toDataURL("image/png") };
  const definition: ParticleDefinition = {
    ...perfDefinition("pixel", 1), image: "pixel", area: { type: "point" },
    rate: 1, max_particles: 1, size: { min: 20, max: 20 },
    velocity_x: { min: 0, max: 0 }, velocity_y: { min: 0, max: 0 }, gravity_y: 0,
    rotation_deg: { min: 0, max: 0 }, angular_velocity_deg: { min: 0, max: 0 },
    alpha_start: 1, alpha_end: 1,
  };
  const kit = pixiSceneKit();
  const create = kit.application;
  let application: SceneApplicationLike | undefined;
  kit.application = () => { application = create(); return application; };
  const canvas = document.createElement("canvas");
  const surface = new SceneSurface({ canvas, kit, particles: { pixel: definition } });
  try {
    console.info("Visual gate: isolated particle sampling");
    await surface.init();
    const world = {
      camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
      sprites: { image: { ...spritePreset("item", { type: "image", asset: "pixel" }), x: 100, y: 100, anchor_x: 0, anchor_y: 0, scale: 20 } },
      emitters: { pixel: { particle: "pixel", seed: 1, generation: 1, space: "world" as const, x: 240, y: 120, scale: 1, rotation_deg: 0, opacity: 1, z: 1 } },
    };
    if (!surface.applyWorld(await surface.prepare({ world, assets }))) throw new Error("sampling world rejected");
    surface.seekParticles(0);
    const app = application as unknown as Application;
    app.render();
    // SceneApplicationLike is an adapter, not Pixi Application: it has no screen.
    // Use the design frame rather than extracting a crop of the stage bounds.
    const rendered = app.renderer.extract.canvas({ target: app.stage, frame: new Rectangle(0, 0, 1920, 1080) }) as HTMLCanvasElement;
    const pixels = rendered.getContext("2d")!.getImageData(0, 120, rendered.width, 1).data;
    const intermediate = (left: number, right: number) => {
      let count = 0;
      for (let x = left; x < right; x += 1) {
        const red = pixels[x * 4]!;
        if (red > 0 && red < 255) count += 1;
      }
      return count;
    };
    const sprites: { x: number; y: number; width: number; height: number; sampling: string }[] = [];
    const inspect = (node: Container) => {
      if (node instanceof Sprite) sprites.push({ x: node.x, y: node.y, width: node.width, height: node.height, sampling: node.texture.source.style.scaleMode });
      for (const child of node.children) inspect(child);
    };
    inspect(app.stage);
    const opaque = (left: number, right: number) => {
      let count = 0;
      for (let x = left; x < right; x += 1) if (pixels[x * 4 + 3]! > 250) count += 1;
      return count;
    };
    const report = {
      particle_intermediate_pixels: intermediate(230, 250),
      sprite_intermediate_pixels: intermediate(110, 130),
      particle_opaque_pixels: opaque(225, 255),
      sprite_opaque_pixels: opaque(105, 135),
      sprite_sampling: sprites.map((sprite) => sprite.sampling),
    };
    if (report.particle_intermediate_pixels !== 0 || report.sprite_intermediate_pixels < 5
      || report.particle_opaque_pixels !== 30 || report.sprite_opaque_pixels !== 30
      || report.sprite_sampling.some((sampling) => sampling !== "linear")) {
      throw new Error(`Particle sampling isolation failed: ${JSON.stringify(report)}`);
    }
    surface.reset();
    if (surface.particleStats.textures !== 0) throw new Error("Sampling variants leaked after reset");
    return report;
  } finally { surface.dispose(); }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0).toFixed(3));
}

function countParticleContainers(node: Container): number {
  let count = node instanceof ParticleContainer ? 1 : 0;
  for (const child of node.children) count += countParticleContainers(child);
  return count;
}

const PARTICLE_ASSETS = { "particle.soft_dot": "/game/assets/particles/soft_dot.png" };

function perfDefinition(id: string, live: number): ParticleDefinition {
  // Fixed 2 s lifetime: rate × lifetime = steady live count, capped by max_particles.
  return {
    schema_version: 2, id, image: "particle.soft_dot", area: { type: "rectangle", width: 1600, height: 200 },
    rate: live / 2, burst_count: 0, max_particles: live, lifetime_ms: { min: 2000, max: 2000 },
    velocity_x: { min: -60, max: 60 }, velocity_y: { min: 80, max: 220 }, gravity_x: 0, gravity_y: 30,
    size: { min: 0.3, max: 0.8 }, rotation_deg: { min: 0, max: 360 }, angular_velocity_deg: { min: -90, max: 90 },
    alpha_start: 1, alpha_end: 0, blend: "normal", seed: 11,
  };
}

/**
 * Real WebGL particle cost: two whole emitters per scenario (containers must
 * scale with emitters, never with particles), deterministic seek per frame,
 * actual draw calls, plus repeated enter/exit to prove resources return.
 */
async function probeParticles() {
  const kit = pixiSceneKit();
  const create = kit.application;
  let application: SceneApplicationLike | undefined;
  kit.application = () => { application = create(); return application; };
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const surface = new SceneSurface({ canvas, kit });
  const camera = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
  const scenarios = [];
  try {
    await surface.init();
    const app = application as unknown as Application;
    const gl = (app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    let draws = 0;
    if (gl !== undefined) {
      const drawElements = gl.drawElements.bind(gl);
      const drawArrays = gl.drawArrays.bind(gl);
      gl.drawElements = (...args: Parameters<typeof drawElements>) => { draws += 1; drawElements(...args); };
      gl.drawArrays = (...args: Parameters<typeof drawArrays>) => { draws += 1; drawArrays(...args); };
    }
    const domBaseline = document.querySelectorAll("*").length;
    for (const total of [500, 2000, 5000]) {
      console.info(`Visual gate: particles ${total}`);
      const per = total / 2;
      surface.setVisualResources({}, { a: perfDefinition("a", per), b: perfDefinition("b", per) });
      const emitter = (particle: string, x: number) => ({ particle, seed: 3, generation: 1, space: "world" as const, x, y: 200, scale: 1, rotation_deg: 0, opacity: 1, z: 1 });
      const world = { camera, sprites: {}, emitters: { left: emitter("a", 560), right: emitter("b", 1360) } };
      const prepared = await surface.prepare({ world, assets: PARTICLE_ASSETS });
      if (!surface.applyWorld(prepared)) throw new Error("particle world rejected");
      const update: number[] = [], frame: number[] = [];
      let drawCalls = 0;
      for (let index = 0; index < 180; index += 1) {
        const at = 4000 + index * (1000 / 60);
        const started = performance.now();
        surface.seekParticles(at);
        const evaluated = performance.now();
        draws = 0;
        app.render();
        gl?.finish();
        frame.push(performance.now() - started);
        update.push(evaluated - started);
        drawCalls = Math.max(drawCalls, draws);
      }
      const stats = surface.particleStats;
      // Live RAF intervals while the surface's own render loop animates.
      const intervals: number[] = [];
      await new Promise<void>((done) => {
        let last: number | undefined;
        let until = Infinity;
        const tick = (now: number) => {
          if (last === undefined) until = now + 2000;
          else intervals.push(now - last);
          last = now;
          if (now < until) requestAnimationFrame(tick); else done();
        };
        requestAnimationFrame(tick);
      });
      scenarios.push({
        total, live: stats.live, emitters: stats.emitters, capacity: stats.capacity,
        particle_containers: countParticleContainers(app.stage), textures: stats.textures, draw_calls: drawCalls,
        update_ms: { p50: percentile(update, 0.5), p95: percentile(update, 0.95), max: percentile(update, 1) },
        frame_ms: { p50: percentile(frame, 0.5), p95: percentile(frame, 0.95), max: percentile(frame, 1) },
        raf_interval_ms: {
          p50: percentile(intervals, 0.5), p95: percentile(intervals, 0.95), max: percentile(intervals, 1),
          over_33ms: intervals.filter((interval) => interval > 33.4).length, samples: intervals.length,
        },
        dom_delta: document.querySelectorAll("*").length - domBaseline,
      });
    }
    // Repeated enter/exit: everything a scene with emitters created is released.
    const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const cycles: { emitters: number; containers: number; textures: number }[] = [];
    const heapBefore = heap();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const world = { camera, sprites: {}, emitters: { left: { particle: "a", seed: cycle, generation: cycle + 1, space: "world" as const, x: 600, y: 200, scale: 1, rotation_deg: 0, opacity: 1, z: 1 } } };
      surface.applyWorld(await surface.prepare({ world, assets: PARTICLE_ASSETS }));
      surface.seekParticles(3000);
      app.render();
      surface.reset();
      app.render();
      cycles.push({ emitters: surface.particleStats.emitters, containers: countParticleContainers(app.stage), textures: surface.particleStats.textures });
    }
    const leaked = cycles.some((cycle) => cycle.emitters !== 0 || cycle.containers !== 0 || cycle.textures !== 0);
    const report = { renderer: app.renderer.name, scenarios, reset_cycles: cycles.length, leaked, heap_delta_bytes: heap() - heapBefore };
    if (leaked || scenarios.some((scenario) => scenario.particle_containers !== 2 || scenario.emitters !== 2 || scenario.dom_delta !== 0
      || scenario.live < scenario.total * 0.9 || scenario.live > scenario.total)) {
      throw new Error(`Particle gate failed: ${JSON.stringify(report)}`);
    }
    return report;
  } finally {
    surface.dispose();
    canvas.remove();
  }
}

async function thumbnailPixels(surface: SceneSurface) {
  const thumbnail = surface.captureThumbnail();
  if (thumbnail === null) throw new Error("SceneSurface.captureThumbnail() returned null");
  const image = new Image();
  image.src = thumbnail;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  return { thumbnail, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

async function probeSurface(definition: TextBlockDefinition) {
  const kit = pixiSceneKit();
  const create = kit.application;
  let application: SceneApplicationLike | undefined;
  kit.application = () => { application = create(); return application; };
  const source = { definition, font_url: "/game/assets/fonts/fusion-pixel-12px-monospaced-zh_hans.ttf" };
  const surfaceCanvas = document.createElement("canvas");
  document.body.appendChild(surfaceCanvas);
  const surface = new SceneSurface({ canvas: surfaceCanvas, kit, textBlocks: { probe: source } });
  try {
    console.info("Visual gate: initializing Surface");
    await surface.init();
    console.info("Visual gate: preparing shared text");
    const system = application!.renderer.htmlText!;
    let generated = 0, returned = 0;
    const createTexture = system.getTexturePromise.bind(system);
    const returnTexture = system.returnTexturePromise.bind(system);
    system.getTexturePromise = (options) => { generated += 1; return createTexture(options); };
    system.returnTexturePromise = (promise) => { returned += 1; return returnTexture(promise); };
    const state = { ...spritePreset("text", { type: "text", text_block: "probe" }), x: 240, y: 240, anchor_x: 0, anchor_y: 0 };
    const camera = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
    const world = { camera, sprites: { first: state, second: { ...state, x: 1080 } } };
    surface.applyWorld(await surface.prepare({ world, assets: {} }));
    console.info("Visual gate: capturing Surface");
    const custom = await thumbnailPixels(surface);
    let ink = 0, outside = 0;
    for (let i = 0; i < custom.pixels.length; i += 4) {
      if (custom.pixels[i]! < 32) continue;
      ink += 1;
      const x = (i / 4) % 320, y = Math.floor(i / 4 / 320);
      if (y < 40 || y >= 80 || !((x >= 40 && x < 160) || (x >= 180 && x < 300))) outside += 1;
    }
    if (ink < 400 || outside !== 0 || generated !== 1) throw new Error(`Surface text gate failed: ${JSON.stringify({ ink, outside, generated })}`);
    surface.applyWorld(await surface.prepare({ world: { ...world, sprites: { first: { ...state, rotation_deg: 12, scale: 0.9 } } }, assets: {} }));
    const transformed = await thumbnailPixels(surface);
    if (!Array.from(transformed.pixels).some((value, i) => i % 4 === 0 && value > 64) || generated !== 1) throw new Error("Transform re-rasterized or lost text");
    // Removing the project font must visibly change the glyphs in the actual
    // Surface thumbnail, not merely change a CSS string or cache key.
    console.info("Visual gate: comparing font");
    surface.setVisualResources({ probe: { definition } }, {});
    surface.applyWorld(await surface.prepare({ world, assets: {} }));
    const fallback = await thumbnailPixels(surface);
    let fontDifference = 0;
    for (let i = 0; i < custom.pixels.length; i += 4) if (Math.abs(custom.pixels[i]! - fallback.pixels[i]!) > 32) fontDifference += 1;
    if (fontDifference < 100) throw new Error(`Custom font not visible: ${fontDifference}`);
    surface.reset();
    if (generated !== 2 || returned !== 2 || surface.particleStats.textures !== 0) throw new Error(`Text resource leak: ${JSON.stringify({ generated, returned })}`);
    return { surface_ink: ink, surface_outside: outside, font_difference: fontDifference, generated, returned, thumbnail: custom.thumbnail };
  } finally { surface.dispose(); }
}

Object.assign(window, { visualResources: probe() });
