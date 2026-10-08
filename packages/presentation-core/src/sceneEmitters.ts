/**
 * Particle emitters of a scene surface.
 *
 * Each emitter draws through a Pixi particle batch over a nearest-sampling
 * copy of its image.  The copies are shared per decoded texture, so however
 * many emitters or bursts draw one image the surface holds a single copy.
 */

import {
  MAX_SURFACE_PARTICLES,
  ParticleEvaluator,
  validateEmitter,
  validateParticleDefinition,
  type EmitterSnapshot,
  type ParticleDefinition,
  type ParticleMap,
} from "./particles";
import type { PreparedAsset, SceneAssets } from "./sceneAssets";
import type { SceneCueLifecycle } from "./sceneCueLifecycle";
import type { SceneObjectFrame } from "./sceneFrame";
import type {
  SceneKit,
  SceneNodeLike,
  SceneParticleBatchLike,
} from "./sceneKit";
import type { SceneCueContext, SceneVisualCue } from "./sceneSurfaceTypes";
import type { SceneTextureLike } from "./sceneTextures";

interface SceneEmitterView {
  state: EmitterSnapshot;
  version: string;
  evaluator: ParticleEvaluator;
  batch: SceneParticleBatchLike;
  /** Shared decoded texture whose nearest-sampling copy the batch draws. */
  particleBase: SceneTextureLike;
  refs: string[];
  elapsedMs: number;
  burst: boolean;
}

export interface SceneEmittersOptions {
  kit: SceneKit;
  assets: SceneAssets;
  lifecycle: SceneCueLifecycle;
  particles: ParticleMap;
  /** The camera or screen layer an emitter of that coordinate space lives in. */
  parentOf(space?: "world" | "screen"): SceneNodeLike;
  requestRender(): void;
}

export class SceneEmitters {
  particles: ParticleMap;
  readonly #options: SceneEmittersOptions;
  readonly #views = new Map<string, SceneEmitterView>();
  /**
   * Nearest-sampling copies of particle images, keyed by the shared decoded
   * texture.  Every emitter of the same image holds one reference, so the
   * surface keeps one copy per image however many emitters or bursts draw it.
   */
  readonly #textures = new Map<
    SceneTextureLike,
    { texture: SceneTextureLike; refs: number }
  >();

  constructor(options: SceneEmittersOptions) {
    this.#options = options;
    this.particles = options.particles;
  }

  get size(): number {
    return this.#views.size;
  }

  /** Nearest-sampling particle copies resident on this surface and their emitter references. */
  get textures(): { resident: number; refs: number } {
    let refs = 0;
    for (const entry of this.#textures.values()) refs += entry.refs;
    return { resident: this.#textures.size, refs };
  }

  stats(): { emitters: number; live: number; capacity: number } {
    let live = 0,
      capacity = 0;
    for (const view of this.#views.values()) {
      live += view.evaluator.count;
      capacity += view.evaluator.definition.max_particles;
    }
    return { emitters: this.#views.size, live, capacity };
  }

  /** Selection geometry of an emitter is its area, never the individual particles. */
  emitterSize(particle: string): { width: number; height: number } {
    const area = this.particles[particle]?.area;
    return area?.type === "rectangle"
      ? { width: Math.max(24, area.width), height: Math.max(24, area.height) }
      : { width: 24, height: 24 };
  }

  /** Persistent (non-burst) emitters, as a timeline's inheritance seed. */
  capture(): Record<string, EmitterSnapshot> {
    const emitters: Record<string, EmitterSnapshot> = {};
    for (const [id, view] of this.#views)
      if (!view.burst) emitters[id] = { ...view.state };
    return emitters;
  }

  #release(id: string): void {
    const view = this.#views.get(id);
    if (view === undefined) return;
    this.#views.delete(id);
    view.batch.destroy();
    // The nearest-sampling copy shares the decoded bitmap of the base texture,
    // so it goes away before the references that keep the base resident.
    this.#releaseTexture(view.particleBase);
    this.#options.assets.releaseRefs(view.refs);
  }

  clear(): void {
    for (const id of this.#views.keys()) this.#release(id);
  }

  validateWorld(states: Record<string, EmitterSnapshot>): void {
    let budget = 0;
    for (const [id, state] of Object.entries(states)) {
      if (id.startsWith("burst:"))
        throw new Error("发射器实例 ID 使用了保留前缀");
      validateEmitter(state);
      const definition = this.particles[state.particle];
      if (definition === undefined)
        throw new Error(`粒子效果不存在: ${state.particle}`);
      validateParticleDefinition(definition);
      budget += definition.max_particles;
    }
    for (const view of this.#views.values())
      if (view.burst) budget += view.evaluator.definition.max_particles;
    if (budget > MAX_SURFACE_PARTICLES) throw new Error("粒子总量超过画布预算");
  }

  validateResource(
    state: EmitterSnapshot,
    prepared?: PreparedAsset,
  ): ParticleDefinition {
    validateEmitter(state);
    const definition = this.particles[state.particle];
    if (definition === undefined)
      throw new Error(`粒子效果不存在: ${state.particle}`);
    validateParticleDefinition(definition);
    const texture = prepared?.textures[0];
    if (
      texture === undefined ||
      prepared?.source.animation !== undefined ||
      texture.width > 512 ||
      texture.height > 512
    ) {
      throw new Error("粒子图片必须为不超过 512×512 的静态图片");
    }
    return definition;
  }

  /** Brings the persistent emitters in line with a committed world. */
  reconcile(
    states: Record<string, EmitterSnapshot>,
    resources: ReadonlyMap<string, PreparedAsset>,
  ): void {
    for (const [id, view] of this.#views) {
      if (view.burst) continue;
      const state = states[id];
      const prepared =
        state === undefined
          ? undefined
          : resources.get(this.particles[state.particle]!.image);
      if (
        state === undefined ||
        prepared === undefined ||
        view.version !== this.#version(state, prepared)
      )
        this.#release(id);
    }
    for (const [id, state] of Object.entries(states)) {
      const prepared = resources.get(this.particles[state.particle]!.image)!;
      const view = this.#views.get(id);
      if (
        view !== undefined &&
        !view.burst &&
        view.version === this.#version(state, prepared)
      ) {
        this.#pose(view, state);
      } else this.#create(id, state, prepared, false);
    }
  }

  /** Applies the evaluated pose of a persistent emitter. */
  applyFrameObject(object: SceneObjectFrame): void {
    const view = this.#views.get(object.id.slice("emitter:".length));
    if (view !== undefined && !view.burst)
      this.#pose(view, {
        ...view.state,
        x: object.x,
        y: object.y,
        scale: object.scale,
        rotation_deg: object.rotation_deg,
        opacity: object.opacity,
        z: object.z,
        space: object.space ?? view.state.space,
      });
  }

  async cue(
    cue: Extract<SceneVisualCue, { type: "particle_state" }>,
    context: SceneCueContext,
  ): Promise<void> {
    const { assets, lifecycle } = this.#options;
    const key = cue.burst ? `burst:${cue.cue_id}` : `emitter:${cue.emitter_id}`;
    const generation = lifecycle.generation;
    const token = lifecycle.beginRequest(key);
    if (cue.emitter === null) {
      this.#release(cue.emitter_id);
      this.#options.requestRender();
      return;
    }
    const definition = this.particles[cue.emitter.particle];
    if (definition === undefined)
      throw new Error(`粒子效果不存在: ${cue.emitter.particle}`);
    const prepared = await assets.acquire(definition.image, context.assets);
    try {
      if (
        context.signal.aborted ||
        !lifecycle.isLatestRequest(generation, key, token)
      )
        return;
      const id = cue.burst ? `burst:${cue.cue_id}` : cue.emitter_id;
      this.#create(id, cue.emitter, prepared, cue.burst);
      this.#options.requestRender();
    } finally {
      assets.releasePrepared(prepared);
    }
  }

  /** Deterministic editor decoration preview; no wall clock is consulted. */
  seek(elapsedMs: number): void {
    for (const view of this.#views.values()) {
      view.elapsedMs = elapsedMs;
      view.batch.update(
        view.evaluator.data,
        view.evaluator.evaluate(elapsedMs),
      );
    }
    this.#options.requestRender();
  }

  /** Advances every emitter by one wall-clock step; true when any is drawing. */
  tick(deltaMs: number): boolean {
    const hasParticles = this.#views.size > 0;
    for (const [id, view] of this.#views) {
      view.elapsedMs += deltaMs;
      view.batch.update(
        view.evaluator.data,
        view.evaluator.evaluate(view.elapsedMs),
      );
      if (
        view.burst &&
        view.elapsedMs >= view.evaluator.definition.lifetime_ms.max
      )
        this.#release(id);
    }
    return hasParticles;
  }

  #retainTexture(base: SceneTextureLike): SceneTextureLike {
    const existing = this.#textures.get(base);
    if (existing !== undefined) {
      existing.refs += 1;
      return existing.texture;
    }
    const texture = this.#options.kit.particleTexture(base);
    this.#textures.set(base, { texture, refs: 1 });
    return texture;
  }

  #releaseTexture(base: SceneTextureLike): void {
    const entry = this.#textures.get(base);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.#textures.delete(base);
    entry.texture.destroy(true);
  }

  #version(state: EmitterSnapshot, prepared: PreparedAsset): string {
    return JSON.stringify([
      this.particles[state.particle],
      state.seed,
      state.generation,
      prepared.version,
    ]);
  }

  #pose(view: SceneEmitterView, state: EmitterSnapshot): void {
    const previous = this.#options.parentOf(view.state.space);
    const parent = this.#options.parentOf(state.space);
    if (previous !== parent) {
      previous.removeChild(view.batch.node);
      parent.addChild(view.batch.node);
    }
    view.state = state;
    view.batch.node.position.set(state.x, state.y);
    view.batch.node.scale.set(state.scale, state.scale);
    view.batch.node.rotation = (state.rotation_deg * Math.PI) / 180;
    view.batch.node.alpha = state.opacity;
    view.batch.node.zIndex = state.z;
  }

  #create(
    id: string,
    state: EmitterSnapshot,
    prepared: PreparedAsset,
    burst: boolean,
  ): void {
    const definition = this.validateResource(state, prepared);
    let budget = definition.max_particles;
    for (const [otherId, view] of this.#views)
      if (otherId !== id) budget += view.evaluator.definition.max_particles;
    if (budget > MAX_SURFACE_PARTICLES) throw new Error("粒子总量超过画布预算");
    const evaluator = new ParticleEvaluator(definition, state.seed, burst);
    const texture = prepared.textures[0]!;
    const life = definition.lifetime_ms.max / 1000;
    const area =
      definition.area.type === "rectangle"
        ? definition.area
        : { width: 0, height: 0 };
    const extentX =
      area.width / 2 +
      Math.max(
        Math.abs(definition.velocity_x.min),
        Math.abs(definition.velocity_x.max),
      ) *
        life +
      (Math.abs(definition.gravity_x) * life ** 2) / 2 +
      Math.hypot(texture.width, texture.height) * definition.size.max;
    const extentY =
      area.height / 2 +
      Math.max(
        Math.abs(definition.velocity_y.min),
        Math.abs(definition.velocity_y.max),
      ) *
        life +
      (Math.abs(definition.gravity_y) * life ** 2) / 2 +
      Math.hypot(texture.width, texture.height) * definition.size.max;
    // Retained before the previous view of this id is released, so replacing an
    // emitter of the same image keeps its nearest-sampling copy alive.
    const sampled = this.#retainTexture(texture);
    let batch: SceneParticleBatchLike;
    try {
      batch = this.#options.kit.particles(
        sampled,
        definition.max_particles,
        definition.blend,
        { x: -extentX, y: -extentY, width: extentX * 2, height: extentY * 2 },
      );
    } catch (error) {
      this.#releaseTexture(texture);
      throw error;
    }
    this.#release(id);
    const view: SceneEmitterView = {
      state,
      version: this.#version(state, prepared),
      evaluator,
      batch,
      particleBase: texture,
      refs: this.#options.assets.claim(prepared),
      elapsedMs: 0,
      burst,
    };
    this.#views.set(id, view);
    this.#options.parentOf(state.space).addChild(batch.node);
    this.#pose(view, state);
    batch.update(evaluator.data, evaluator.evaluate(0));
  }
}
