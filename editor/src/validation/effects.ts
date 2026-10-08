import type { BackgroundTransitionSpec, ScreenEffectSpec } from "../types";
import { validateColorValue } from "./shared";

/** Mirrors `validate_background_transition` in the Rust content model. */
export function validateBackgroundTransition(
  transition: BackgroundTransitionSpec,
  issue: (code: string, message: string) => void,
): void {
  switch (transition.type) {
    case "cut":
    case "cross_fade":
      return;
    case "fade_through_color":
      validateColorValue(transition.color, "转场颜色", issue);
      return;
    case "wipe":
    case "push":
      if (
        !Number.isFinite(transition.softness) ||
        transition.softness < 0 ||
        transition.softness > 1
      ) {
        issue("invalid_transition_softness", "转场柔边必须在 0–1 之间");
      }
      return;
  }
}

/** Mirrors `validate_screen_effect` in the Rust content model. */
export function validateScreenEffect(
  effect: ScreenEffectSpec,
  issue: (code: string, message: string) => void,
): void {
  if (effect.type === "flash") {
    validateColorValue(effect.color, "闪光颜色", issue);
    if (
      !Number.isFinite(effect.peak_alpha) ||
      effect.peak_alpha < 0 ||
      effect.peak_alpha > 1
    ) {
      issue("invalid_flash_peak", "闪光峰值透明度必须在 0–1 之间");
    }
    return;
  }
  if (effect.type !== "shake") {
    validateShaderEffect(effect, issue);
    return;
  }
  for (const [label, value] of [
    ["横向振幅", effect.amplitude_x],
    ["纵向振幅", effect.amplitude_y],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 256) {
      issue("invalid_shake_amplitude", `${label}必须在 0–256 之间`);
    }
  }
  if (
    !Number.isFinite(effect.frequency_hz) ||
    effect.frequency_hz < 0.1 ||
    effect.frequency_hz > 60
  ) {
    issue("invalid_shake_frequency", "震动频率必须在 0.1–60 Hz 之间");
  }
  if (!Number.isFinite(effect.decay) || effect.decay < 0 || effect.decay > 1) {
    issue("invalid_shake_decay", "震动衰减必须在 0–1 之间");
  }
  if (
    !Number.isInteger(effect.seed) ||
    effect.seed < 0 ||
    effect.seed > 0xffff_ffff
  ) {
    issue("invalid_shake_seed", "震动 seed 必须是 0–4294967295 的整数");
  }
}

/** Shader effect ranges, mirroring `validate_screen_effect` in Rust. */
function validateShaderEffect(
  effect: Extract<
    ScreenEffectSpec,
    {
      type:
        | "chromatic_aberration"
        | "glitch"
        | "shockwave"
        | "color_grade"
        | "focus"
        | "ripple";
    }
  >,
  issue: (code: string, message: string) => void,
): void {
  const range = (
    code: string,
    label: string,
    value: number,
    min: number,
    max: number,
  ): void => {
    if (!Number.isFinite(value) || value < min || value > max) {
      issue(code, `${label}必须在 ${min}–${max} 之间`);
    }
  };
  const center = (
    prefix: string,
    value: { center_x: number; center_y: number },
  ): void => {
    range(`invalid_${prefix}_center`, "中心 X", value.center_x, 0, 1920);
    range(`invalid_${prefix}_center`, "中心 Y", value.center_y, 0, 1080);
  };
  const fades = (
    prefix: string,
    value: { fade_in: number; fade_out: number },
  ): void => {
    range(`invalid_${prefix}_fade`, "渐入比例", value.fade_in, 0, 1);
    range(`invalid_${prefix}_fade`, "渐出比例", value.fade_out, 0, 1);
    if (value.fade_in + value.fade_out > 1) {
      issue(`invalid_${prefix}_fade`, "渐入与渐出比例之和不能超过 1");
    }
  };
  const intensity = (prefix: string, value: number): void => {
    range(`invalid_${prefix}_intensity`, "效果强度", value, 0, 1);
  };
  switch (effect.type) {
    case "chromatic_aberration":
      range(
        "invalid_chromatic_intensity",
        "色差强度",
        effect.intensity,
        0,
        128,
      );
      range(
        "invalid_chromatic_angle",
        "色差方向角度",
        effect.angle_deg,
        -360,
        360,
      );
      center("chromatic", effect);
      range(
        "invalid_chromatic_edge_weight",
        "色差边缘权重",
        effect.edge_weight,
        0,
        1,
      );
      fades("chromatic", effect);
      return;
    case "glitch":
      range(
        "invalid_glitch_displacement",
        "故障位移",
        effect.displacement,
        0,
        512,
      );
      if (
        !Number.isInteger(effect.slice_count) ||
        effect.slice_count < 1 ||
        effect.slice_count > 32
      ) {
        issue("invalid_glitch_slice_count", "故障切片数必须是 1–32 的整数");
      }
      range("invalid_glitch_density", "故障切片密度", effect.density, 0, 1);
      range(
        "invalid_glitch_frequency",
        "故障变化频率",
        effect.frequency_hz,
        0.1,
        60,
      );
      if (
        !Number.isInteger(effect.seed) ||
        effect.seed < 0 ||
        effect.seed > 0xffff_ffff
      ) {
        issue("invalid_glitch_seed", "故障 seed 必须是 0–4294967295 的整数");
      }
      fades("glitch", effect);
      return;
    case "shockwave":
      center("shockwave", effect);
      range(
        "invalid_shockwave_radius",
        "冲击波最大半径",
        effect.max_radius,
        1,
        4096,
      );
      range(
        "invalid_shockwave_width",
        "冲击波波宽",
        effect.wave_width,
        1,
        1024,
      );
      range(
        "invalid_shockwave_strength",
        "冲击波扭曲强度",
        effect.strength,
        0,
        256,
      );
      return;
    case "color_grade":
      range(
        "invalid_color_grade_brightness",
        "亮度偏移",
        effect.brightness,
        -1,
        1,
      );
      range("invalid_color_grade_contrast", "对比度", effect.contrast, 0, 2);
      range(
        "invalid_color_grade_saturation",
        "饱和度",
        effect.saturation,
        0,
        2,
      );
      validateColorValue(effect.tint, "着色颜色", issue);
      range(
        "invalid_color_grade_tint_strength",
        "着色强度",
        effect.tint_strength,
        0,
        1,
      );
      intensity("color_grade", effect.intensity);
      fades("color_grade", effect);
      return;
    case "focus":
      center("focus", effect);
      range("invalid_focus_radius", "清晰半径", effect.radius, 0, 2203);
      range("invalid_focus_softness", "边缘过渡", effect.softness, 1, 2203);
      range("invalid_focus_blur", "最大模糊", effect.blur, 0, 24);
      range("invalid_focus_darkness", "边缘压暗", effect.darkness, 0, 1);
      intensity("focus", effect.intensity);
      fades("focus", effect);
      return;
    case "ripple":
      center("ripple", effect);
      range("invalid_ripple_amplitude", "波纹振幅", effect.amplitude, 0, 64);
      range(
        "invalid_ripple_wavelength",
        "波纹波长",
        effect.wavelength,
        8,
        2203,
      );
      range("invalid_ripple_speed", "波纹速度", effect.speed, 0, 2000);
      range("invalid_ripple_damping", "波纹衰减", effect.damping, 0, 8);
      intensity("ripple", effect.intensity);
      fades("ripple", effect);
      return;
  }
}
