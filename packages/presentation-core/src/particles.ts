import type { CoordinateSpace } from "./visual";

export interface ParticleRange { min: number; max: number }
export interface ParticleDefinition {
  schema_version: number;
  id: string;
  image: string;
  area: { type: "point" } | { type: "rectangle"; width: number; height: number };
  rate: number;
  burst_count: number;
  max_particles: number;
  lifetime_ms: ParticleRange;
  velocity_x: ParticleRange;
  velocity_y: ParticleRange;
  gravity_x: number;
  gravity_y: number;
  size: ParticleRange;
  rotation_deg: ParticleRange;
  angular_velocity_deg: ParticleRange;
  alpha_start: number;
  alpha_end: number;
  blend: "normal" | "add";
  seed: number;
}
export interface EmitterSnapshot {
  particle: string;
  seed: number;
  generation: number;
  space: CoordinateSpace;
  x: number;
  y: number;
  scale: number;
  rotation_deg: number;
  opacity: number;
  z: number;
}
export type ParticleMap = Readonly<Record<string, ParticleDefinition>>;
export const MAX_EMITTER_PARTICLES = 5000;
export const MAX_SURFACE_PARTICLES = 10000;
/** x, y, scale, rotation (radians), alpha; reused for every evaluation. */
export const PARTICLE_STRIDE = 5;

function random(seed: number, index: number, channel: number): number {
  let value = (seed ^ Math.imul(index >>> 0, 0x9e3779b1)
    ^ Math.imul(Math.floor(index / 0x100000000), 0x85ebca6b)
    ^ Math.imul(channel + 1, 0xc2b2ae35)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}
function sample(range: ParticleRange, seed: number, index: number, channel: number): number {
  return range.min + (range.max - range.min) * random(seed, index, channel);
}

export function validateParticleDefinition(definition: ParticleDefinition): void {
  const ranges = [definition.lifetime_ms, definition.velocity_x, definition.velocity_y,
    definition.size, definition.rotation_deg, definition.angular_velocity_deg];
  if (ranges.some(({ min, max }) => !Number.isFinite(min) || !Number.isFinite(max) || min > max)
    || definition.lifetime_ms.min < 1 || definition.lifetime_ms.max > 30000
    || definition.size.min <= 0 || definition.size.max > 100
    || !Number.isInteger(definition.max_particles) || definition.max_particles < 1
    || definition.max_particles > MAX_EMITTER_PARTICLES
    || !Number.isInteger(definition.burst_count) || definition.burst_count < 0 || definition.burst_count > definition.max_particles
    || definition.schema_version !== 2
    || !Number.isInteger(definition.seed) || definition.seed < 0 || definition.seed > 0xffffffff
    || !["point", "rectangle"].includes(definition.area.type)
    || !Number.isFinite(definition.rate) || definition.rate < 0 || definition.rate > 10000
    || ![definition.gravity_x, definition.gravity_y].every(Number.isFinite)
    || ![definition.alpha_start, definition.alpha_end].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    || !["normal", "add"].includes(definition.blend)
    || (definition.area.type === "rectangle" && ![definition.area.width, definition.area.height].every((value) => Number.isFinite(value) && value >= 0 && value <= 16384))) {
    throw new Error(`粒子效果参数无效: ${definition.id}`);
  }
}

export function validateEmitter(state: EmitterSnapshot): void {
  if (![state.x, state.y, state.scale, state.rotation_deg, state.opacity, state.z].every(Number.isFinite)
    || state.scale <= 0 || state.opacity < 0 || state.opacity > 1
    || !["world", "screen"].includes(state.space)
    || ![state.seed, state.generation].every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) {
    throw new Error("粒子发射器状态无效");
  }
}

/**
 * Analytic particles: seeking never integrates from zero or allocates objects.
 * Saturation drops the oldest emissions, including expired slots, so evaluating
 * the latest max_particles emission indices is O(capacity) at any playhead.
 */
export class ParticleEvaluator {
  readonly data: Float32Array;
  count = 0;
  constructor(readonly definition: ParticleDefinition, readonly seed: number, readonly burst = false) {
    validateParticleDefinition(definition);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("粒子种子无效");
    this.data = new Float32Array(definition.max_particles * PARTICLE_STRIDE);
  }

  evaluate(elapsedMs: number): number {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > Number.MAX_SAFE_INTEGER / 10) throw new Error("粒子时间无效");
    const d = this.definition;
    const last = this.burst ? d.burst_count - 1 : d.rate > 0 ? Math.floor(elapsedMs * d.rate / 1000) : -1;
    const first = Math.max(0, last - d.max_particles + 1);
    let count = 0;
    for (let index = first; index <= last; index += 1) {
      const ageMs = elapsedMs - (this.burst ? 0 : index * 1000 / d.rate);
      const life = sample(d.lifetime_ms, this.seed, index, 0);
      if (ageMs < 0 || ageMs >= life) continue;
      const seconds = ageMs / 1000;
      const offset = count++ * PARTICLE_STRIDE;
      const width = d.area.type === "rectangle" ? d.area.width : 0;
      const height = d.area.type === "rectangle" ? d.area.height : 0;
      this.data[offset] = (random(this.seed, index, 1) - 0.5) * width
        + sample(d.velocity_x, this.seed, index, 3) * seconds + 0.5 * d.gravity_x * seconds ** 2;
      this.data[offset + 1] = (random(this.seed, index, 2) - 0.5) * height
        + sample(d.velocity_y, this.seed, index, 4) * seconds + 0.5 * d.gravity_y * seconds ** 2;
      this.data[offset + 2] = sample(d.size, this.seed, index, 5);
      this.data[offset + 3] = (sample(d.rotation_deg, this.seed, index, 6)
        + sample(d.angular_velocity_deg, this.seed, index, 7) * seconds) * Math.PI / 180;
      this.data[offset + 4] = d.alpha_start + (d.alpha_end - d.alpha_start) * ageMs / life;
    }
    this.count = count;
    return count;
  }
}
