import { validateParticleDefinition } from "@vectspace/presentation-core/particles";
import { validateTextBlock } from "@vectspace/presentation-core/text-block";
import { spriteFit } from "@vectspace/presentation-core/visual";
import { ID_PATTERN } from "./app/ids";
import type {
  EditorDiagnostic,
  EditorProject,
  SpriteNode,
  TimelineTrack,
} from "./types";

type Issue = (code: string, message: string) => void;

export function validateSpriteAuthoring(
  project: EditorProject,
  sprite: SpriteNode | Extract<TimelineTrack, { type: "sprite" }>,
  issue: Issue,
): void {
  const source = sprite.source;
  if (source !== undefined) {
    if (sprite.asset != null || ("character" in sprite && sprite.character != null))
      issue("conflicting_sprite_source", "source 不能与旧 asset / character 同时指定");
    if (source.type === "image") {
      const asset = project.manifest.assets[source.asset];
      if (asset === undefined || !["background", "sprite", "gui"].includes(asset.kind))
        issue("invalid_sprite_source", `Sprite 图片来源不存在或不是图像：${source.asset}`);
    } else if (source.type === "text") {
      if (!(project.text_blocks ?? []).some((file) => file.definition.id === source.text_block))
        issue("invalid_sprite_source", `固定文本块不存在：${source.text_block}`);
    } else {
      issue("invalid_sprite_source", "Sprite 来源必须是 image 或 text");
    }
  }
  if (sprite.sprite_kind !== undefined && !["background", "character", "item", "ui", "text"].includes(sprite.sprite_kind))
    issue("invalid_sprite_kind", "Sprite 类别无效");
  if (sprite.space !== undefined && !["world", "screen"].includes(sprite.space))
    issue("invalid_coordinate_space", "坐标空间必须是 world 或 screen");
  if (sprite.layout != null) {
    try {
      spriteFit(1, 1, sprite.layout);
    } catch {
      issue("invalid_sprite_layout", "布局尺寸必须在 0–16384 之间，并选择 contain / cover / stretch");
    }
  }
  if (sprite.sprite_id === "__background__")
    issue("reserved_sprite_id", "__background__ 是旧背景适配器保留的实例 ID");
  if ("action" in sprite) {
    if ([sprite.scale_x, sprite.scale_y].some((value) => value != null && (!Number.isFinite(value) || value === 0)))
      issue("invalid_sprite_scale", "轴向缩放必须是非零有限数");
    if (sprite.rotation_deg != null && !Number.isFinite(sprite.rotation_deg))
      issue("invalid_sprite_rotation", "旋转必须是有限数");
    if ([sprite.anchor_x, sprite.anchor_y].some((value) => value != null && (!Number.isFinite(value) || value < 0 || value > 1)))
      issue("invalid_sprite_anchor", "锚点必须在 0–1 之间");
  }
}

/** Mirrors the host's exact manifest/file sets and shared visual limits. */
export function validateVisualDocuments(project: EditorProject): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  const issue: Issue = (code, message) => diagnostics.push({
    severity: "error", code, message, scene_id: null, node_id: null,
  });
  const ids = new Set([
    ...Object.keys(project.manifest.assets),
    ...(project.animations ?? []).map((file) => file.definition.id),
    ...(project.actions ?? []).map((file) => file.definition.id),
  ]);
  for (const [kind, paths, files] of [
    ["text_block", project.manifest.text_blocks ?? [], project.text_blocks ?? []],
    ["particle", project.manifest.particles ?? [], project.particles ?? []],
  ] as const) {
    const expected = new Set(paths);
    const actual = new Set(files.map((file) => file.path));
    if (expected.size !== paths.length || actual.size !== files.length
      || expected.size !== actual.size || [...expected].some((path) => !actual.has(path)))
      issue("visual_document_set_mismatch", `${kind} 文档文件清单与 manifest 不一致`);
    for (const file of files) {
      const id = file.definition.id;
      if (!ID_PATTERN.test(id)) issue("invalid_visual_id", `视觉文档 ID 非法：${id}`);
      if (ids.has(id)) issue("duplicate_visual_id", `视觉文档 ID 与资源冲突：${id}`);
      ids.add(id);
    }
  }
  for (const { definition } of project.text_blocks ?? []) {
    try {
      validateTextBlock(definition);
      if (definition.schema_version !== 2 || !Number.isInteger(definition.width) || !Number.isInteger(definition.height))
        throw new Error("版本必须为 2，宽高必须为整数");
    } catch (reason) {
      issue("invalid_text_block", `${definition.id}：${reason instanceof Error ? reason.message : String(reason)}`);
    }
    if (definition.font != null && project.manifest.assets[definition.font]?.kind !== "font")
      issue("invalid_text_block_font", `固定文本块 ${definition.id} 的字体未登记：${definition.font}`);
  }
  for (const { definition } of project.particles ?? []) {
    try {
      validateParticleDefinition(definition);
    } catch (reason) {
      issue("invalid_particle_definition", `${definition.id}：${reason instanceof Error ? reason.message : String(reason)}`);
    }
    const asset = project.manifest.assets[definition.image];
    if (asset === undefined || !["background", "sprite", "gui"].includes(asset.kind)
      || asset.path == null || asset.animation != null)
      issue("invalid_particle_image", `粒子 ${definition.id} 必须使用单张静态图片`);
    const metadata = project.assets.find((candidate) => candidate.id === definition.image)?.metadata;
    if (metadata != null && ((metadata.width ?? 0) > 512 || (metadata.height ?? 0) > 512))
      issue("particle_image_too_large", `粒子 ${definition.id} 图片最大为 512×512`);
  }
  return diagnostics;
}
