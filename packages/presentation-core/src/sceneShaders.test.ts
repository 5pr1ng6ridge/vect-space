import { Container, type Filter } from "pixi.js";
import { describe, expect, it } from "vitest";

import {
  COLOR_GRADE_FRAGMENT,
  CHROMATIC_ABERRATION_FRAGMENT,
  FOCUS_FRAGMENT,
  GLITCH_FRAGMENT,
  RIPPLE_FRAGMENT,
  SHOCKWAVE_FRAGMENT,
  createPixiShaderHost,
} from "./sceneShaders";
import {
  EMPTY_SHADER_EFFECT_FRAME,
  type ColorGradeFrame,
  type FocusFrame,
  type RippleFrame,
  type ShaderEffectFrame,
} from "./sceneEffects";

const RECT = { x: -10, y: -20, width: 1940, height: 1120 };

const RIPPLE: RippleFrame = {
  centerX: 960,
  centerY: 540,
  amplitude: 12,
  wavelength: 160,
  waveOffset: 60,
  damping: 1,
  taper: 40,
};

const SHOCKWAVE = {
  centerX: 400,
  centerY: 300,
  radius: 120,
  waveWidth: 140,
  strength: 28,
};

const GLITCH = { offsets: [0, 12, -3], phase: 0.25 };

const COLOR_GRADE: ColorGradeFrame = {
  brightness: 0.25,
  contrast: 1.4,
  saturation: 1.5,
  tintR: 1,
  tintG: 0.5,
  tintB: 0,
  tintStrength: 0.6,
  mix: 0.8,
};

const FOCUS: FocusFrame = {
  centerX: 960,
  centerY: 540,
  radius: 280,
  softness: 160,
  maxBlur: 8,
  darkness: 0.3,
};

const CHROMATIC = {
  offsetX: 12,
  offsetY: 0,
  centerX: 960,
  centerY: 540,
  edgeWeight: 0.6,
};

function frameWith(overrides: Partial<ShaderEffectFrame>): ShaderEffectFrame {
  return { ...EMPTY_SHADER_EFFECT_FRAME, ...overrides };
}

function filtersOf(container: Container): Filter[] {
  return (container.filters ?? []) as Filter[];
}

/**
 * Pixi wraps a fragment with precision/version preamble, so a pass is
 * identified by a uniform that is unique to its GLSL rather than by string
 * equality with the exported source.
 */
const PASS_MARKERS: Readonly<Record<string, string>> = {
  ripple: "uWaveOffset",
  shockwave: "uWaveWidth",
  glitch: "uOffsets",
  colorGrade: "uTintStrength",
  focus: "uFinalPass",
  chromaticAberration: "uEdgeWeight",
};

function passKinds(container: Container): string[] {
  return filtersOf(container).map((filter) => {
    const fragment = String(fragmentOf(filter));
    for (const [kind, marker] of Object.entries(PASS_MARKERS)) {
      if (fragment.includes(marker)) return kind;
    }
    return "unknown";
  });
}

function fragmentOf(filter: Filter): unknown {
  return (filter.glProgram as unknown as { fragment: unknown }).fragment;
}

function floatArray(value: unknown): number[] {
  return value instanceof Float32Array ? [...value] : [];
}

function uniformsOf(filter: Filter): Record<string, unknown> {
  const resources = filter.resources as unknown as {
    effectUniforms?: { uniforms?: Record<string, unknown> };
  };
  return resources.effectUniforms?.uniforms ?? {};
}

describe("createPixiShaderHost", () => {
  it("installs nothing for an idle frame and removes the filters once", () => {
    const container = new Container();
    const host = createPixiShaderHost(container);
    host.apply(EMPTY_SHADER_EFFECT_FRAME, RECT);
    expect(container.filters).toBeFalsy();
    host.apply(frameWith({ shockwave: SHOCKWAVE }), RECT);
    expect(filtersOf(container)).toHaveLength(1);
    host.apply(EMPTY_SHADER_EFFECT_FRAME, RECT);
    expect(container.filters).toBeFalsy();
    // A second empty frame must not touch the display list again.
    host.apply(EMPTY_SHADER_EFFECT_FRAME, RECT);
    expect(container.filters).toBeFalsy();
    host.destroy();
  });

  it("runs every pass in the fixed order", () => {
    const container = new Container();
    const host = createPixiShaderHost(container);
    host.apply(
      frameWith({
        ripple: RIPPLE,
        shockwave: SHOCKWAVE,
        glitch: GLITCH,
        colorGrade: COLOR_GRADE,
        focus: FOCUS,
        chromaticAberration: CHROMATIC,
      }),
      RECT,
    );
    const fragments = filtersOf(container).map(fragmentOf);
    // ripple → shockwave → glitch → grade → focus H → focus V → chromatic.
    expect(passKinds(container)).toEqual([
      "ripple",
      "shockwave",
      "glitch",
      "colorGrade",
      "focus",
      "focus",
      "chromaticAberration",
    ]);
    expect(fragments).toHaveLength(7);
    expect(container.filterArea).toMatchObject(RECT);
    host.destroy();
  });

  it("installs a single darkening pass when the focus blur is zero", () => {
    const container = new Container();
    const host = createPixiShaderHost(container);
    host.apply(frameWith({ focus: { ...FOCUS, maxBlur: 0 } }), RECT);
    const filters = filtersOf(container);
    expect(filters).toHaveLength(1);
    expect(passKinds(container)).toEqual(["focus"]);
    // The darkening pass is the final (vertical) one.
    expect(uniformsOf(filters[0]).uFinalPass).toBe(1);
    expect(uniformsOf(filters[0]).uMaxBlur).toBe(0);
    expect(uniformsOf(filters[0]).uDarkness).toBeCloseTo(0.3);
    host.destroy();
  });

  it("takes a single sample for zero effective blur and still darkens once", () => {
    // Structural regression for the bypass: a darken-only focus (and the sharp
    // centre disc of a normal focus) must resolve to one clamped texel fetch,
    // never the nine-tap Gaussian.  The behavioural proof lives in the real
    // WebGL blur probe; this pins the GLSL code path itself, which a
    // filter-count assertion cannot see.
    const branch =
      /if \(blur <= 0\.0\)\s*\{([\s\S]*?)\}\s*else\s*\{([\s\S]*?)\}\s*if \(uFinalPass > 0\.5\)\s*\{([\s\S]*?)\}\s*finalColor/.exec(
        FOCUS_FRAGMENT,
      );
    expect(branch).not.toBeNull();
    const [, zeroBlurBranch, blurBranch, darkenBranch] =
      branch as RegExpExecArray;
    // Zero effective blur: exactly one clamped fetch, no loop, no taps.
    expect(zeroBlurBranch?.match(/texture\s*\(/g)).toHaveLength(1);
    expect(zeroBlurBranch).toContain(
      "clamp(vTextureCoord, uInputClamp.xy, uInputClamp.zw)",
    );
    expect(zeroBlurBranch).not.toContain("for (");
    // The fixed nine-tap Gaussian runs only on the blurring branch.
    expect(blurBranch?.match(/for \(/g)).toHaveLength(1);
    expect(blurBranch).toContain("for (int i = -4; i <= 4; i++)");
    expect(blurBranch).toContain("color = sum / total;");
    // Darkening is applied once, after the branch, so the zero-blur path still
    // darkens with the same mask.
    expect(
      darkenBranch?.match(/color\.rgb \*= \(1\.0 - uDarkness \* mask\);/g),
    ).toHaveLength(1);
  });

  it("wires the evaluator uniforms into each pass", () => {
    const container = new Container();
    const host = createPixiShaderHost(container);
    host.apply(
      frameWith({
        ripple: RIPPLE,
        colorGrade: COLOR_GRADE,
        focus: FOCUS,
      }),
      RECT,
    );
    const filters = filtersOf(container);
    const [ripple, grade, focusH, focusV] = filters.map(uniformsOf);
    expect(floatArray(ripple.uCenter)).toMatchObject([960, 540]);
    expect(ripple.uAmplitude).toBeCloseTo(12);
    expect(ripple.uWaveOffset).toBeCloseTo(60);
    expect(ripple.uTaper).toBeCloseTo(40);
    expect(floatArray(grade.uTint)).toMatchObject([1, 0.5, 0]);
    expect(grade.uBrightness).toBeCloseTo(0.25);
    expect(grade.uContrast).toBeCloseTo(1.4);
    expect(grade.uSaturation).toBeCloseTo(1.5);
    expect(grade.uTintStrength).toBeCloseTo(0.6);
    expect(grade.uMix).toBeCloseTo(0.8);
    expect(floatArray(focusH.uDirection)).toMatchObject([1, 0]);
    expect(focusH.uFinalPass).toBe(0);
    expect(floatArray(focusV.uDirection)).toMatchObject([0, 1]);
    expect(focusV.uFinalPass).toBe(1);
    expect(focusV.uMaxBlur).toBeCloseTo(8);
    host.destroy();
  });

  it("reuses the compiled filters until the pass set changes", () => {
    const container = new Container();
    const host = createPixiShaderHost(container);
    host.apply(frameWith({ shockwave: SHOCKWAVE }), RECT);
    const installed = container.filters;
    host.apply(frameWith({ shockwave: { ...SHOCKWAVE, radius: 400 } }), {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    expect(container.filters).toBe(installed);
    host.destroy();
  });

  it("releases every filter on destroy", () => {
    const container = new Container();
    const host = createPixiShaderHost(container);
    host.apply(
      frameWith({
        ripple: RIPPLE,
        shockwave: SHOCKWAVE,
        glitch: GLITCH,
        colorGrade: COLOR_GRADE,
        focus: FOCUS,
        chromaticAberration: CHROMATIC,
      }),
      RECT,
    );
    const filters = filtersOf(container);
    expect(filters).toHaveLength(7);
    host.destroy();
    expect(container.filters).toBeFalsy();
    for (const filter of filters) {
      expect((filter as unknown as { _destroyed?: boolean })._destroyed).toBe(
        true,
      );
    }
    // A late frame after destroy is ignored instead of resurrecting filters.
    host.apply(frameWith({ shockwave: SHOCKWAVE }), RECT);
    expect(container.filters).toBeFalsy();
  });

  it("documents the new fragment uniform contracts", () => {
    expect(RIPPLE_FRAGMENT).toContain("uniform float uWaveOffset;");
    expect(RIPPLE_FRAGMENT).toContain("2203.0");
    expect(COLOR_GRADE_FRAGMENT).toContain("uniform float uMix;");
    expect(COLOR_GRADE_FRAGMENT).toContain("out vec4 finalColor;");
    expect(FOCUS_FRAGMENT).toContain("uniform float uFinalPass;");
    expect(FOCUS_FRAGMENT).toContain("clamp(vTextureCoord + offset");
    // The shipped passes are untouched.
    expect(SHOCKWAVE_FRAGMENT).toContain("uniform float uWaveWidth;");
    expect(GLITCH_FRAGMENT).toContain("uniform float uPhase;");
    expect(CHROMATIC_ABERRATION_FRAGMENT).toContain("uniform vec2 uOffset;");
  });
});
