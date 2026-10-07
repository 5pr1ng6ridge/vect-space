import type { ParticleDefinition, EmitterSnapshot } from "./particles";
import type { TextBlockDefinition } from "./textBlock";

export const PARTICLE_FIXTURE: ParticleDefinition = {
  schema_version: 2, id: "snow", image: "dot", area: { type: "rectangle", width: 400, height: 100 },
  rate: 40, burst_count: 20, max_particles: 200, lifetime_ms: { min: 1500, max: 3000 },
  velocity_x: { min: -20, max: 20 }, velocity_y: { min: 30, max: 80 }, gravity_x: 0, gravity_y: 10,
  size: { min: 0.5, max: 1 }, rotation_deg: { min: 0, max: 360 }, angular_velocity_deg: { min: -30, max: 30 },
  alpha_start: 1, alpha_end: 0, blend: "normal", seed: 17,
};

export const EMITTER_FIXTURE: EmitterSnapshot = {
  particle: "snow", seed: 17, generation: 1, space: "world", x: 960, y: 100,
  scale: 1, rotation_deg: 0, opacity: 1, z: 2,
};

export const TEXT_FIXTURE: TextBlockDefinition = {
  schema_version: 2, id: "label", content: "中文 $x^2$", width: 400, height: 100,
  font_size: 24, line_height: 1.3, padding: 8, color: "#FFFFFF", align: "left", vertical_align: "top",
};
