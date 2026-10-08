import type {
  BackgroundTransitionSpec,
  CurtainTransitionSpec,
  ScreenEffectSpec,
  TransitionDirection,
} from "../types";

/** Short author-facing description of one canonical background transition. */
export function summarizeTransitionSpec(
  transition: BackgroundTransitionSpec | CurtainTransitionSpec,
): string {
  switch (transition.type) {
    case "cut":
      return "直接切换";
    case "cross_fade":
      return "交叉淡化";
    case "fade":
      return "淡入淡出";
    case "fade_through_color":
      return `淡过 ${transition.color}`;
    case "wipe":
      return `划像 ${directionLabel(transition.direction)}`;
    case "push":
      return `推入 ${directionLabel(transition.direction)}`;
    case "split_horizontal":
      return "水平对开";
    case "split_vertical":
      return "垂直对开";
  }
}

/** Short author-facing description of one canonical screen effect. */
export function summarizeScreenEffect(effect: ScreenEffectSpec): string {
  switch (effect.type) {
    case "flash":
      return `闪光 ${effect.color}`;
    case "shake":
      return `震动 ${effect.amplitude_x}×${effect.amplitude_y} · ${effect.frequency_hz}Hz · seed ${effect.seed}`;
    case "chromatic_aberration":
      return `色差 ${effect.intensity}px · ${effect.angle_deg}°`;
    case "glitch":
      return `故障 ${effect.displacement}px · ${effect.slice_count} 切片 · ${effect.frequency_hz}Hz · seed ${effect.seed}`;
    case "shockwave":
      return `冲击波 (${effect.center_x}, ${effect.center_y}) · 半径 ${effect.max_radius}px`;
    case "color_grade":
      return `色彩修正 亮度 ${effect.brightness} · 对比度 ${effect.contrast} · 饱和度 ${effect.saturation}`;
    case "focus":
      return `聚焦 (${effect.center_x}, ${effect.center_y}) · 清晰半径 ${effect.radius}px · 模糊 ${effect.blur}px`;
    case "ripple":
      return `波纹 (${effect.center_x}, ${effect.center_y}) · 振幅 ${effect.amplitude}px · 波长 ${effect.wavelength}px`;
  }
}

function directionLabel(direction: TransitionDirection): string {
  switch (direction) {
    case "left_to_right":
      return "从左到右";
    case "right_to_left":
      return "从右到左";
    case "top_to_bottom":
      return "从上到下";
    case "bottom_to_top":
      return "从下到上";
  }
}
