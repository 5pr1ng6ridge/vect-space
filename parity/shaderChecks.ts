import type { SceneFrame } from "@vectspace/presentation-core/scene-frame";
import type { ScreenEffectSpec } from "@vectspace/presentation-core/types";
import {
  annulusMeanDiff,
  centerClearance,
  darkenModelDiff,
  diffStats,
  discMeanDiff,
  edgeEnergy,
  relativeChangeGrid,
  unchangedCentroid,
  type PixelFrame,
} from "./pixels";
import {
  isComposableEffect,
  type ComposableShaderType,
  type ScreenEffectEvent,
} from "./timelineUpdates";
import type { TargetShaderReport } from "./types";

export function shaderCheck(
  report: TargetShaderReport,
  name: string,
  ok: boolean,
  detail: string,
): void {
  report.checks.push({ name, ok, detail });
}

/**
 * Real-WebGL blur-only assertions for one `focus` event.
 *
 * `blurred` is the authored blur with darkening removed, `sharp` is the same
 * frame with both blur and darkening removed, and `darken` keeps only the
 * darkening.  The checks are content-independent: they compare the same ring
 * of the same scene, so they cannot pass on a pure darkening.
 */
export function evaluateFocusBlurChecks(
  report: TargetShaderReport,
  blurred: PixelFrame,
  sharp: PixelFrame,
  darken: PixelFrame,
  focus: Extract<ScreenEffectSpec, { type: "focus" }>,
): void {
  const designPerPixel = 1920 / sharp.width;
  const centerX = focus.center_x / designPerPixel;
  const centerY = focus.center_y / designPerPixel;
  const radiusPx = focus.radius / designPerPixel;
  const softnessPx = focus.softness / designPerPixel;
  // The blur mask is exactly 1 beyond `radius + softness`; run the ring out to
  // the farthest frame corner so the shorter vertical extent cannot truncate
  // it into an empty (vacuously passing) sample.
  const innerRadius = Math.max(1, radiusPx + softnessPx);
  const outerRadius = Math.hypot(
    Math.max(centerX, sharp.width - centerX),
    Math.max(centerY, sharp.height - centerY),
  );
  const sharpEdges = edgeEnergy(
    sharp,
    centerX,
    centerY,
    innerRadius,
    outerRadius,
  );
  const blurredEdges = edgeEnergy(
    blurred,
    centerX,
    centerY,
    innerRadius,
    outerRadius,
  );
  const reduction =
    sharpEdges.energy > 0 ? 1 - blurredEdges.energy / sharpEdges.energy : 0;
  const centerDiff = discMeanDiff(
    blurred,
    sharp,
    centerX,
    centerY,
    Math.max(2, radiusPx * 0.5),
  );
  const darkenDiff = darkenModelDiff(
    sharp,
    darken,
    centerX,
    centerY,
    radiusPx,
    softnessPx,
    focus.darkness,
  );
  report.blurProbe = {
    sharpEdgeEnergy: sharpEdges.energy,
    blurredEdgeEnergy: blurredEdges.energy,
    detailReduction: reduction,
    centerMeanDiff: centerDiff,
    darkenModelDiff: darkenDiff,
    annulusPixels: sharpEdges.count,
    annulusPixelsBlurred: blurredEdges.count,
  };
  shaderCheck(
    report,
    "focus 模糊探针边缘纹理充足（抗空洞）",
    sharpEdges.count > 500 && sharpEdges.energy >= 4,
    `sharpEdgeEnergy=${sharpEdges.energy.toFixed(3)} pixels=${sharpEdges.count}`,
  );
  shaderCheck(
    report,
    "focus 仅模糊显著降低边缘细节",
    reduction >= 0.2,
    `sharpEdgeEnergy=${sharpEdges.energy.toFixed(3)} blurredEdgeEnergy=${blurredEdges.energy.toFixed(3)} reduction=${(reduction * 100).toFixed(1)}%`,
  );
  shaderCheck(
    report,
    "focus 仅模糊保持清晰中心不变",
    centerDiff <= 2.5,
    `centerMeanDiff=${centerDiff.toFixed(3)}`,
  );
  shaderCheck(
    report,
    "focus 零模糊路径仅按遮罩变暗（单采样）",
    darkenDiff <= 4,
    `darkenModelDiff=${darkenDiff.toFixed(3)} darkness=${focus.darkness} blur=0`,
  );
}

export function evaluateShaderChecks(
  report: TargetShaderReport,
  type: ComposableShaderType,
  events: ScreenEffectEvent[],
  frame: SceneFrame,
  sampleMs: number,
  on: PixelFrame,
  off: PixelFrame,
  removed: PixelFrame,
): void {
  // `captureThumbnail` maps the 1920x1080 stage into 320x180.
  const designPerPixel = 1920 / on.width;
  const visible = diffStats(on, off);
  const identity = diffStats(off, removed);
  const effect = events.find((event) => event.effect.type === type)?.effect;
  const composable =
    effect !== undefined && isComposableEffect(effect) ? effect : null;
  // The shader coordinate is a stage pixel of the fixed 1920x1080 viewport, so
  // the authored centre maps to the same place on screen no matter how the
  // camera is panned/zoomed/rotated.
  const expected =
    composable === null || composable.type === "color_grade"
      ? null
      : {
          x: composable.center_x / designPerPixel,
          y: composable.center_y / designPerPixel,
        };

  let centerFocusMean: number | null = null;
  let peripheryFocusMean: number | null = null;
  let screenCenterClearance: number | null = null;
  let sharpDisc: {
    x: number;
    y: number;
    count: number;
    bounds: { x: number; y: number };
  } | null = null;
  const screenCenter = {
    x: 960 / designPerPixel,
    y: 540 / designPerPixel,
  };
  if (composable !== null && composable.type === "focus" && expected !== null) {
    const radius = composable.radius / designPerPixel;
    const outer = (composable.radius + composable.softness) / designPerPixel;
    const centerX = expected.x;
    const centerY = expected.y;
    centerFocusMean = centerClearance(
      on,
      off,
      centerX,
      centerY,
      Math.max(2, radius * 0.5),
    );
    // The same clearance at the fixed stage centre distinguishes a design-pixel
    // anchor from a screen-space anchor under a camera transform.
    screenCenterClearance = centerClearance(
      on,
      off,
      screenCenter.x,
      screenCenter.y,
      Math.max(2, radius * 0.5),
    );
    peripheryFocusMean = annulusMeanDiff(
      on,
      off,
      centerX,
      centerY,
      outer,
      outer + 60,
    );
    sharpDisc = unchangedCentroid(on, off);
  }

  report.observations.push({
    effect: type,
    elapsedMs: sampleMs,
    meanAbsDiff: visible.mean,
    centroid: { x: visible.x, y: visible.y },
    expectedCenter: expected,
    centerFocusMean,
    peripheryFocusMean,
    expectedCenterClearance: centerFocusMean,
    screenCenterClearance,
    sharpDiscCentroid: sharpDisc,
    relativeGrid: relativeChangeGrid(on, off, 16, 9),
    screenCenter: {
      x: screenCenter.x * designPerPixel,
      y: screenCenter.y * designPerPixel,
    },
    camera: { ...frame.camera },
  });

  shaderCheck(
    report,
    `${type} 像素可见`,
    visible.mean > 1,
    `meanAbsDiff=${visible.mean.toFixed(3)} centroid=(${visible.x.toFixed(1)}, ${visible.y.toFixed(1)})`,
  );
  shaderCheck(
    report,
    `${type} 零强度与移除等效`,
    identity.mean < 0.5,
    `meanAbsDiff=${identity.mean.toFixed(3)}`,
  );
  if (sharpDisc !== null && peripheryFocusMean !== null && expected !== null) {
    const expectedX = expected.x;
    const expectedY = expected.y;
    const discX = sharpDisc.bounds.x;
    const discY = sharpDisc.bounds.y;
    const distance =
      sharpDisc.count === 0
        ? Infinity
        : Math.hypot(discX - expectedX, discY - expectedY);
    shaderCheck(
      report,
      "focus 清晰盘中心保持在设计像素位置（不随镜头漂移）",
      distance <= 20,
      `sharpDiscBounds=(${discX.toFixed(1)}, ${discY.toFixed(1)}) centroid=(${sharpDisc.x.toFixed(1)}, ${sharpDisc.y.toFixed(1)}) pixels=${sharpDisc.count} expected=(${expectedX.toFixed(1)}, ${expectedY.toFixed(1)}) screenCenter=(${screenCenter.x.toFixed(1)}, ${screenCenter.y.toFixed(1)}) distance=${Number.isFinite(distance) ? distance.toFixed(1) : "inf"}px@320x180 centerRelative=${(centerFocusMean ?? -1).toFixed(4)} screenCenterRelative=${(screenCenterClearance ?? -1).toFixed(4)}`,
    );
    shaderCheck(
      report,
      "focus 边缘明显改变",
      peripheryFocusMean > 1,
      `peripheryMean=${peripheryFocusMean.toFixed(3)}`,
    );
  }
}
