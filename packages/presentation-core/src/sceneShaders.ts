/**
 * Post-processing shaders for the screen effects that geometry cannot express.
 *
 * `sceneEffects.ts` turns an authored spec and a playhead into plain uniform
 * values; this module owns the GLSL and the Pixi filters that consume them.
 * The split keeps the rule "the shader draws, the playhead decides when and
 * how strongly": nothing here has a clock, a random source or authored state.
 *
 * The host post-processes exactly one container (the world layer).  Its
 * passes always run in the same order — ripple, shockwave, glitch,
 * colour grade, focus (horizontal/vertical) and chromatic aberration — so
 * geometric distortions are resolved before the grade, the grade before the
 * focus blur and the channel split colours their edges, and stacking is never
 * order-dependent on the authored timeline.  An all-`null` frame removes every
 * filter, so an idle scene runs no post-processing at all.
 *
 * Coordinates: the filter area always covers the whole 1920x1080 stage, so in
 * every pass `vTextureCoord * uInputSize.xy` is the design-pixel position (the
 * filter bounds start at the stage origin and the surface renders at
 * resolution 1).  Displaced samples are clamped to `uInputClamp`, which
 * repeats the stage edge instead of pulling in transparent black.
 */

import {
  Filter,
  GlProgram,
  Rectangle,
  UniformGroup,
  defaultFilterVert,
  type Container,
} from "pixi.js";

import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./sceneFrame";
import {
  GLITCH_SLICE_COUNT_MAX,
  RIPPLE_FALLOFF_DISTANCE,
  isShaderEffectFrameEmpty,
  type ChromaticAberrationFrame,
  type ColorGradeFrame,
  type FocusFrame,
  type GlitchFrame,
  type RippleFrame,
  type ShaderEffectFrame,
  type ShockwaveFrame,
} from "./sceneEffects";

/** Rectangle in the local space of the post-processed container. */
export interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Post-processing port of one container.
 *
 * `apply` installs exactly the passes the frame asks for, in the fixed order,
 * over `area`; `destroy` removes and releases every filter.
 */
export interface SceneShaderHostLike {
  apply(frame: ShaderEffectFrame, area: SceneRect): void;
  destroy(): void;
}

const STAGE_SIZE = `vec2(${DESIGN_WIDTH.toFixed(1)}, ${DESIGN_HEIGHT.toFixed(1)})`;

/**
 * Ring of radial displacement.  Inside the ring (`|s| < 1`) every pixel
 * samples from closer to the centre with a smooth `(1 - s²)²` profile, so the
 * image bulges outward along the wave front and is untouched elsewhere.
 */
export const SHOCKWAVE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;

uniform vec2 uCenter;
uniform float uRadius;
uniform float uWaveWidth;
uniform float uStrength;

void main(void)
{
    vec2 pixel = vTextureCoord * uInputSize.xy;
    vec2 delta = pixel - uCenter;
    float dist = length(delta);
    float s = (dist - uRadius) / max(uWaveWidth * 0.5, 0.0001);
    vec2 uv = vTextureCoord;
    if (abs(s) < 1.0 && dist > 0.0001) {
        float bump = 1.0 - s * s;
        float displacement = min(uStrength * bump * bump, dist);
        uv = (pixel - (delta / dist) * displacement) * uInputSize.zw;
    }
    finalColor = texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw));
}
`;

/**
 * Horizontal band displacement.  The offset table is looked up with a
 * constant-bound loop so the program stays valid where dynamic uniform-array
 * indexing is not guaranteed.
 */
export const GLITCH_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;

uniform float uOffsets[${GLITCH_SLICE_COUNT_MAX}];
uniform float uSliceCount;
uniform float uPhase;

void main(void)
{
    vec2 pixel = vTextureCoord * uInputSize.xy;
    float band = floor(pixel.y / ${STAGE_SIZE}.y * uSliceCount + uPhase);
    int index = int(mod(band, uSliceCount));
    float offset = 0.0;
    for (int i = 0; i < ${GLITCH_SLICE_COUNT_MAX}; i++) {
        if (i == index) offset = uOffsets[i];
    }
    vec2 uv = vec2(pixel.x - offset, pixel.y) * uInputSize.zw;
    finalColor = texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw));
}
`;

/**
 * RGB channel split.  Red samples at `+offset`, blue at `-offset`, green stays
 * put; `uEdgeWeight` blends between a uniform split and one that grows from
 * the centre to the farthest stage corner.  The alpha is the maximum of the
 * three samples, which keeps the premultiplied output valid and lets the
 * fringe extend past an object's own edge.
 */
export const CHROMATIC_ABERRATION_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;

uniform vec2 uOffset;
uniform vec2 uCenter;
uniform float uEdgeWeight;

void main(void)
{
    vec2 pixel = vTextureCoord * uInputSize.xy;
    vec2 farthest = max(uCenter, ${STAGE_SIZE} - uCenter);
    float reach = max(length(farthest), 1.0);
    float distanceWeight = clamp(length(pixel - uCenter) / reach, 0.0, 1.0);
    float weight = mix(1.0, distanceWeight, uEdgeWeight);
    vec2 shift = uOffset * weight * uInputSize.zw;
    vec4 red = texture(uTexture, clamp(vTextureCoord + shift, uInputClamp.xy, uInputClamp.zw));
    vec4 base = texture(uTexture, clamp(vTextureCoord, uInputClamp.xy, uInputClamp.zw));
    vec4 blue = texture(uTexture, clamp(vTextureCoord - shift, uInputClamp.xy, uInputClamp.zw));
    finalColor = vec4(red.r, base.g, blue.b, max(max(red.a, base.a), blue.a));
}
`;

/**
 * Signed periodic concentric displacement.
 *
 * The phase is a pure function of the design-pixel distance and the phase
 * advance (`uWaveOffset = speed * local seconds`), so a seek reproduces the
 * exact same wave.  The amplitude is scaled by a smooth centre taper (the
 * radial direction is undefined at the centre) and by the exponential spatial
 * falloff `exp(-damping * distance / 2203)`, and every displaced sample is
 * clamped to the stage edge.
 */
export const RIPPLE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;

uniform vec2 uCenter;
uniform float uAmplitude;
uniform float uWavelength;
uniform float uWaveOffset;
uniform float uDamping;
uniform float uTaper;

void main(void)
{
    vec2 pixel = vTextureCoord * uInputSize.xy;
    vec2 delta = pixel - uCenter;
    float dist = length(delta);
    vec2 uv = vTextureCoord;
    if (dist > 0.0001) {
        float taper = smoothstep(0.0, max(uTaper, 0.0001), dist);
        float falloff = exp(-uDamping * dist / ${RIPPLE_FALLOFF_DISTANCE.toFixed(1)});
        float phase = 6.283185307179586 * (dist - uWaveOffset) / max(uWavelength, 0.0001);
        float displacement = uAmplitude * taper * falloff * sin(phase);
        uv = (pixel - (delta / dist) * displacement) * uInputSize.zw;
    }
    finalColor = texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw));
}
`;

/**
 * Straight-RGB colour grade with an enveloped neutral mix.
 *
 * The source is unpremultiplied into straight RGB, graded (brightness,
 * contrast around `0.5`, saturation around the luminance, then a
 * multiplicative tint blended by `uTintStrength`) and mixed with the neutral
 * source by `uMix`; the result is clamped and repremultiplied with the
 * untouched alpha, so transparent pixels stay transparent.
 */
export const COLOR_GRADE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;

uniform vec3 uTint;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uTintStrength;
uniform float uMix;

void main(void)
{
    vec4 src = texture(uTexture, vTextureCoord);
    float alpha = clamp(src.a, 0.0, 1.0);
    vec3 straight = alpha > 0.0001 ? src.rgb / alpha : src.rgb;
    vec3 graded = straight + uBrightness;
    graded = (graded - 0.5) * uContrast + 0.5;
    float luminance = dot(graded, vec3(0.2126, 0.7152, 0.0722));
    graded = mix(vec3(luminance), graded, uSaturation);
    graded = mix(graded, graded * uTint, uTintStrength);
    vec3 mixed = clamp(mix(straight, graded, uMix), 0.0, 1.0);
    finalColor = vec4(mixed * alpha, alpha);
}
`;

/**
 * Separable Gaussian focus pass with a variable per-pixel radius.
 *
 * One draw covers one axis (`uDirection`); the host runs a horizontal and then
 * a vertical pass.  The per-pixel radius is `uMaxBlur` scaled by the
 * `smoothstep(radius, radius + softness, distance)` mask, so the centre disc
 * stays sharp and the periphery blurs.  Nine taps per axis give a bounded
 * fixed budget.  When the effective radius is zero — a darken-only focus, the
 * reduced-motion blur scale, or the sharp centre disc — the pass takes a
 * single clamped sample instead, so no blur tap ever runs for zero blur.
 * Darkening is applied only on the final (vertical) pass, so the mask can
 * never darken twice.
 */
export const FOCUS_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;

uniform vec2 uCenter;
uniform float uRadius;
uniform float uSoftness;
uniform float uMaxBlur;
uniform float uDarkness;
uniform vec2 uDirection;
uniform float uFinalPass;

void main(void)
{
    vec2 pixel = vTextureCoord * uInputSize.xy;
    float dist = length(pixel - uCenter);
    float mask = smoothstep(uRadius, uRadius + max(uSoftness, 0.0001), dist);
    float blur = uMaxBlur * mask;
    vec4 color;
    if (blur <= 0.0) {
        color = texture(uTexture, clamp(vTextureCoord, uInputClamp.xy, uInputClamp.zw));
    } else {
        vec4 sum = vec4(0.0);
        float total = 0.0;
        for (int i = -4; i <= 4; i++) {
            float tap = float(i);
            float weight = exp(-0.5 * tap * tap / 4.0);
            vec2 offset = uDirection * (tap * blur * 0.25) * uInputSize.zw;
            sum += texture(uTexture, clamp(vTextureCoord + offset, uInputClamp.xy, uInputClamp.zw)) * weight;
            total += weight;
        }
        color = sum / total;
    }
    if (uFinalPass > 0.5) {
        color.rgb *= (1.0 - uDarkness * mask);
    }
    finalColor = color;
}
`;

interface ShaderPass<TFrame> {
  readonly filter: Filter;
  update(frame: TFrame): void;
}

function shaderFilter(
  name: string,
  fragment: string,
  uniforms: UniformGroup,
): Filter {
  return new Filter({
    glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment, name }),
    resources: { effectUniforms: uniforms },
  });
}

function createShockwavePass(): ShaderPass<ShockwaveFrame> {
  const uniforms = new UniformGroup({
    uCenter: { value: new Float32Array(2), type: "vec2<f32>" },
    uRadius: { value: 0, type: "f32" },
    uWaveWidth: { value: 1, type: "f32" },
    uStrength: { value: 0, type: "f32" },
  });
  const values = uniforms.uniforms;
  return {
    filter: shaderFilter("vectspace-shockwave", SHOCKWAVE_FRAGMENT, uniforms),
    update(frame) {
      values.uCenter[0] = frame.centerX;
      values.uCenter[1] = frame.centerY;
      values.uRadius = frame.radius;
      values.uWaveWidth = frame.waveWidth;
      values.uStrength = frame.strength;
    },
  };
}

function createGlitchPass(): ShaderPass<GlitchFrame> {
  const uniforms = new UniformGroup({
    uOffsets: {
      value: new Float32Array(GLITCH_SLICE_COUNT_MAX),
      type: "f32",
      size: GLITCH_SLICE_COUNT_MAX,
    },
    uSliceCount: { value: 1, type: "f32" },
    uPhase: { value: 0, type: "f32" },
  });
  const values = uniforms.uniforms;
  return {
    filter: shaderFilter("vectspace-glitch", GLITCH_FRAGMENT, uniforms),
    update(frame) {
      const table = values.uOffsets as Float32Array;
      table.fill(0);
      const count = Math.min(GLITCH_SLICE_COUNT_MAX, frame.offsets.length);
      for (let band = 0; band < count; band += 1) {
        table[band] = frame.offsets[band] ?? 0;
      }
      values.uSliceCount = Math.max(1, count);
      values.uPhase = frame.phase;
    },
  };
}

function createChromaticAberrationPass(): ShaderPass<ChromaticAberrationFrame> {
  const uniforms = new UniformGroup({
    uOffset: { value: new Float32Array(2), type: "vec2<f32>" },
    uCenter: { value: new Float32Array(2), type: "vec2<f32>" },
    uEdgeWeight: { value: 0, type: "f32" },
  });
  const values = uniforms.uniforms;
  return {
    filter: shaderFilter(
      "vectspace-chromatic-aberration",
      CHROMATIC_ABERRATION_FRAGMENT,
      uniforms,
    ),
    update(frame) {
      values.uOffset[0] = frame.offsetX;
      values.uOffset[1] = frame.offsetY;
      values.uCenter[0] = frame.centerX;
      values.uCenter[1] = frame.centerY;
      values.uEdgeWeight = frame.edgeWeight;
    },
  };
}

function createRipplePass(): ShaderPass<RippleFrame> {
  const uniforms = new UniformGroup({
    uCenter: { value: new Float32Array(2), type: "vec2<f32>" },
    uAmplitude: { value: 0, type: "f32" },
    uWavelength: { value: 1, type: "f32" },
    uWaveOffset: { value: 0, type: "f32" },
    uDamping: { value: 0, type: "f32" },
    uTaper: { value: 1, type: "f32" },
  });
  const values = uniforms.uniforms;
  return {
    filter: shaderFilter("vectspace-ripple", RIPPLE_FRAGMENT, uniforms),
    update(frame) {
      values.uCenter[0] = frame.centerX;
      values.uCenter[1] = frame.centerY;
      values.uAmplitude = frame.amplitude;
      values.uWavelength = frame.wavelength;
      values.uWaveOffset = frame.waveOffset;
      values.uDamping = frame.damping;
      values.uTaper = frame.taper;
    },
  };
}

function createColorGradePass(): ShaderPass<ColorGradeFrame> {
  const uniforms = new UniformGroup({
    uTint: { value: new Float32Array([1, 1, 1]), type: "vec3<f32>" },
    uBrightness: { value: 0, type: "f32" },
    uContrast: { value: 1, type: "f32" },
    uSaturation: { value: 1, type: "f32" },
    uTintStrength: { value: 0, type: "f32" },
    uMix: { value: 1, type: "f32" },
  });
  const values = uniforms.uniforms;
  return {
    filter: shaderFilter(
      "vectspace-color-grade",
      COLOR_GRADE_FRAGMENT,
      uniforms,
    ),
    update(frame) {
      values.uTint[0] = frame.tintR;
      values.uTint[1] = frame.tintG;
      values.uTint[2] = frame.tintB;
      values.uBrightness = frame.brightness;
      values.uContrast = frame.contrast;
      values.uSaturation = frame.saturation;
      values.uTintStrength = frame.tintStrength;
      values.uMix = frame.mix;
    },
  };
}

/**
 * One axis of the focus blur.
 *
 * The direction and the "darken on this pass" flag are fixed for the lifetime
 * of the filter; the geometry and the strength come from the current frame, so
 * the horizontal and vertical passes always agree.
 */
function createFocusPass(
  horizontal: boolean,
  finalPass: boolean,
): ShaderPass<FocusFrame> {
  const uDirection = new Float32Array(2);
  uDirection[horizontal ? 0 : 1] = 1;
  const uniforms = new UniformGroup({
    uCenter: { value: new Float32Array(2), type: "vec2<f32>" },
    uRadius: { value: 0, type: "f32" },
    uSoftness: { value: 0, type: "f32" },
    uMaxBlur: { value: 0, type: "f32" },
    uDarkness: { value: 0, type: "f32" },
    uDirection: { value: uDirection, type: "vec2<f32>" },
    uFinalPass: { value: finalPass ? 1 : 0, type: "f32" },
  });
  const values = uniforms.uniforms;
  return {
    filter: shaderFilter("vectspace-focus", FOCUS_FRAGMENT, uniforms),
    update(frame) {
      values.uCenter[0] = frame.centerX;
      values.uCenter[1] = frame.centerY;
      values.uRadius = frame.radius;
      values.uSoftness = frame.softness;
      values.uMaxBlur = frame.maxBlur;
      values.uDarkness = frame.darkness;
    },
  };
}

/**
 * Pixi implementation of the shader host.
 *
 * Filters are compiled lazily the first time their effect appears and reused
 * afterwards; the container's filter list only changes when the set of active
 * passes changes, not on every uniform update.  The fixed pass order is
 * ripple → shockwave → glitch → colour grade → focus (H then V) → chromatic
 * aberration.  A darken-only focus (`maxBlur = 0`) installs its vertical pass
 * alone, so a zero blur never runs a blur tap.
 */
export function createPixiShaderHost(target: Container): SceneShaderHostLike {
  let ripple: ShaderPass<RippleFrame> | null = null;
  let shockwave: ShaderPass<ShockwaveFrame> | null = null;
  let glitch: ShaderPass<GlitchFrame> | null = null;
  let colorGrade: ShaderPass<ColorGradeFrame> | null = null;
  let focusHorizontal: ShaderPass<FocusFrame> | null = null;
  let focusVertical: ShaderPass<FocusFrame> | null = null;
  let chromatic: ShaderPass<ChromaticAberrationFrame> | null = null;
  let installed: readonly Filter[] = [];
  let destroyed = false;
  const area = new Rectangle();

  const install = (filters: readonly Filter[]): void => {
    const unchanged =
      filters.length === installed.length &&
      filters.every((filter, index) => filter === installed[index]);
    if (unchanged) return;
    installed = filters;
    target.filters = filters.length === 0 ? null : [...filters];
  };

  return {
    apply(frame, rect) {
      if (destroyed) return;
      if (isShaderEffectFrameEmpty(frame)) {
        install([]);
        return;
      }
      const passes: Filter[] = [];
      if (frame.ripple !== null) {
        ripple ??= createRipplePass();
        ripple.update(frame.ripple);
        passes.push(ripple.filter);
      }
      if (frame.shockwave !== null) {
        shockwave ??= createShockwavePass();
        shockwave.update(frame.shockwave);
        passes.push(shockwave.filter);
      }
      if (frame.glitch !== null) {
        glitch ??= createGlitchPass();
        glitch.update(frame.glitch);
        passes.push(glitch.filter);
      }
      if (frame.colorGrade !== null) {
        colorGrade ??= createColorGradePass();
        colorGrade.update(frame.colorGrade);
        passes.push(colorGrade.filter);
      }
      if (frame.focus !== null) {
        focusVertical ??= createFocusPass(false, true);
        focusVertical.update(frame.focus);
        if (frame.focus.maxBlur > 0) {
          focusHorizontal ??= createFocusPass(true, false);
          focusHorizontal.update(frame.focus);
          passes.push(focusHorizontal.filter);
        }
        // The vertical pass is also the single darkening pass.
        passes.push(focusVertical.filter);
      }
      if (frame.chromaticAberration !== null) {
        chromatic ??= createChromaticAberrationPass();
        chromatic.update(frame.chromaticAberration);
        passes.push(chromatic.filter);
      }
      area.x = rect.x;
      area.y = rect.y;
      area.width = rect.width;
      area.height = rect.height;
      target.filterArea = area;
      install(passes);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      install([]);
      for (const pass of [
        ripple,
        shockwave,
        glitch,
        colorGrade,
        focusHorizontal,
        focusVertical,
        chromatic,
      ]) {
        pass?.filter.destroy();
      }
      ripple = null;
      shockwave = null;
      glitch = null;
      colorGrade = null;
      focusHorizontal = null;
      focusVertical = null;
      chromatic = null;
    },
  };
}
