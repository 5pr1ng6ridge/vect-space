import {
  IMAGE_ANIMATION_MAX_DECODED_BYTES,
  IMAGE_ANIMATION_MAX_FRAME_MS,
  IMAGE_ANIMATION_MAX_FRAMES,
  IMAGE_ANIMATION_MIN_FRAME_MS,
  IMAGE_ANIMATION_SCHEMA_VERSION,
} from "../imageAnimation";
import type { EditorDiagnostic, EditorProject } from "../types";
import { ID_PATTERN, error } from "./shared";

export function validateAnimations(
  project: EditorProject,
  diagnostics: EditorDiagnostic[],
): void {
  // Image animations (schema v1) mirror the Rust rules so an authoring mistake
  // is reported in the sidebar instead of only at save time.
  const animationFiles = project.animations ?? [];
  const animationIds = new Set<string>();
  const declaredAnimationPaths = new Set(project.manifest.animations ?? []);
  for (const file of animationFiles) {
    const definition = file.definition;
    if (!declaredAnimationPaths.has(file.path)) {
      diagnostics.push(
        error("undeclared_animation", `图片动画文件未登记：${file.path}`),
      );
    }
    if (
      definition.schema_version !== IMAGE_ANIMATION_SCHEMA_VERSION ||
      !ID_PATTERN.test(definition.id)
    ) {
      diagnostics.push(
        error("invalid_animation", `图片动画定义无效：${definition.id}`),
      );
    }
    if (animationIds.has(definition.id)) {
      diagnostics.push(
        error("duplicate_animation", `图片动画 ID 重复：${definition.id}`),
      );
    }
    animationIds.add(definition.id);
    if (project.manifest.assets[definition.id] !== undefined) {
      diagnostics.push(
        error(
          "animation_asset_collision",
          `图片动画 ID ${definition.id} 与素材 ID 冲突：动画 ID 必须独立于素材命名空间`,
        ),
      );
    }
    const frames = definition.frames;
    if (frames.length === 0) {
      diagnostics.push(
        error("empty_animation", `图片动画 ${definition.id} 至少需要一帧`),
      );
    }
    if (frames.length > IMAGE_ANIMATION_MAX_FRAMES) {
      diagnostics.push(
        error(
          "too_many_animation_frames",
          `图片动画 ${definition.id} 的帧数超过 ${IMAGE_ANIMATION_MAX_FRAMES}`,
        ),
      );
    }
    let shared: { width: number; height: number } | undefined;
    let sharedFrame = 0;
    const measured = new Set<string>();
    let decodedBytes = 0;
    for (const [index, frame] of frames.entries()) {
      const position = index + 1;
      if (
        !Number.isInteger(frame.duration_ms) ||
        frame.duration_ms < IMAGE_ANIMATION_MIN_FRAME_MS ||
        frame.duration_ms > IMAGE_ANIMATION_MAX_FRAME_MS
      ) {
        diagnostics.push(
          error(
            "invalid_animation_frame_duration",
            `图片动画 ${definition.id} 第 ${position} 帧时长必须在 ${IMAGE_ANIMATION_MIN_FRAME_MS}–${IMAGE_ANIMATION_MAX_FRAME_MS}ms 之间`,
          ),
        );
      }
      const frameAsset = project.manifest.assets[frame.asset];
      if (frameAsset === undefined) {
        diagnostics.push(
          error(
            "unknown_animation_frame",
            `图片动画 ${definition.id} 第 ${position} 帧引用了未登记的素材 ${frame.asset}`,
          ),
        );
        continue;
      }
      if (!["background", "sprite", "gui"].includes(frameAsset.kind)) {
        diagnostics.push(
          error(
            "invalid_animation_frame_kind",
            `图片动画 ${definition.id} 第 ${position} 帧的素材 ${frame.asset} 不是图片素材`,
          ),
        );
      }
      if (frameAsset.animation !== undefined) {
        diagnostics.push(
          error(
            "nested_animation_frame",
            `图片动画 ${definition.id} 第 ${position} 帧引用了动画素材 ${frame.asset}`,
          ),
        );
      }
      const size = assetPixelSize(project, frame.asset);
      if (size === undefined) continue;
      if (shared === undefined) {
        shared = size;
        sharedFrame = position;
      } else if (shared.width !== size.width || shared.height !== size.height) {
        diagnostics.push(
          error(
            "animation_frame_size_mismatch",
            `图片动画 ${definition.id} 第 ${position} 帧尺寸 ${size.width}×${size.height} 与第 ${sharedFrame} 帧 ${shared.width}×${shared.height} 不一致`,
          ),
        );
      }
      if (!measured.has(frame.asset)) {
        measured.add(frame.asset);
        decodedBytes += size.width * size.height * 4;
      }
    }
    if (decodedBytes > IMAGE_ANIMATION_MAX_DECODED_BYTES) {
      diagnostics.push(
        error(
          "animation_memory_budget",
          `图片动画 ${definition.id} 解码内存超过 ${IMAGE_ANIMATION_MAX_DECODED_BYTES / (1024 * 1024)} MiB 预算`,
        ),
      );
    }
  }
  for (const path of declaredAnimationPaths) {
    if (!animationFiles.some((file) => file.path === path)) {
      diagnostics.push(
        error(
          "missing_animation",
          `manifest 声明了图片动画，但编辑器文档不存在：${path}`,
        ),
      );
    }
  }
  for (const [id, definition] of Object.entries(project.manifest.assets)) {
    if (definition.animation !== undefined) {
      if (definition.path !== undefined) {
        diagnostics.push(
          error(
            "asset_animation_conflict",
            `素材 ${id} 的 path 与 animation 互斥`,
          ),
        );
      }
      if (!["background", "sprite", "gui"].includes(definition.kind)) {
        diagnostics.push(
          error(
            "invalid_animation_owner_kind",
            `动画素材 ${id} 必须是 background、sprite 或 gui 类型`,
          ),
        );
      }
      if (!animationIds.has(definition.animation)) {
        diagnostics.push(
          error(
            "unknown_animation",
            `素材 ${id} 引用了未登记的图片动画 ${definition.animation}`,
          ),
        );
      }
    } else if (definition.path === undefined) {
      diagnostics.push(
        error(
          "asset_without_source",
          `素材 ${id} 必须登记 path 或 animation 之一`,
        ),
      );
    }
  }
}

/** Host-inspected pixel size of one registered asset, when known. */
function assetPixelSize(
  project: EditorProject,
  assetId: string,
): { width: number; height: number } | undefined {
  const metadata = project.assets.find(
    (asset) => asset.id === assetId,
  )?.metadata;
  if (metadata === undefined || metadata === null) return undefined;
  if (metadata.width === null || metadata.height === null) return undefined;
  return { width: metadata.width, height: metadata.height };
}
