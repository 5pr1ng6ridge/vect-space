/**
 * Stable-ID rules for everything an author can create or rename.
 *
 * Every create/rename path used to repeat `/^[A-Za-z0-9._-]{1,128}$/` and
 * report a generic "非法或已经存在".  These helpers return the concrete
 * reason in Chinese so dialogs can show it inline, next to the field.
 */
import type { EditorProject } from "../types";

export const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const ID_RULE_HINT =
  "只能使用英文字母、数字、点（.）、下划线（_）或连字符（-），1–128 个字符。";

export type IdKind =
  | "scene"
  | "node"
  | "variable"
  | "character"
  | "uiMotion"
  | "button"
  | "action"
  | "animation"
  | "textBlock"
  | "particle";

export const ID_KIND_LABELS: Record<IdKind, string> = {
  scene: "场景",
  node: "节点",
  variable: "变量",
  character: "角色",
  uiMotion: "UI 动效",
  button: "按钮模板",
  action: "立绘动作",
  animation: "帧动画",
  textBlock: "固定文本块",
  particle: "粒子效果",
};

/**
 * Who already owns `id` in the shared asset / animation / action / visual
 * document namespace (the Rust loader rejects any collision there).
 */
function sharedNamespaceOwner(
  project: EditorProject,
  id: string,
  self: IdKind,
  previous?: string,
): string | null {
  const owns = (kind: IdKind | "asset", ids: readonly string[]): boolean =>
    ids.some(
      (candidate) =>
        candidate === id && !(kind === self && candidate === previous),
    );
  if (owns("asset", Object.keys(project.manifest.assets))) return "素材";
  if (owns("animation", (project.animations ?? []).map((file) => file.definition.id)))
    return "帧动画";
  if (owns("action", (project.actions ?? []).map((file) => file.definition.id)))
    return "立绘动作";
  if (owns("textBlock", (project.text_blocks ?? []).map((file) => file.definition.id)))
    return "固定文本块";
  if (owns("particle", (project.particles ?? []).map((file) => file.definition.id)))
    return "粒子效果";
  return null;
}

/** Format problem of a raw id, or `null` when the text is a valid id. */
export function idFormatError(id: string): string | null {
  if (id.length === 0) return "ID 不能为空。";
  if (id.length > 128) return "ID 不能超过 128 个字符。";
  if (!ID_PATTERN.test(id)) return `ID 格式不正确：${ID_RULE_HINT}`;
  return null;
}

/** Library documents are stored under a directory derived from their id. */
export function libraryFilePath(
  kind: "uiMotion" | "button" | "action" | "textBlock" | "particle",
  id: string,
): string {
  const file = `${id.replaceAll(".", "_")}.yaml`;
  switch (kind) {
    case "textBlock":
      return `text_blocks/${file}`;
    case "particle":
      return `particles/${file}`;
    case "uiMotion":
      return `ui/motions/${file}`;
    case "button":
      return `ui/buttons/${file}`;
    case "action":
      return `actions/${file}`;
  }
}

/**
 * Why `id` cannot be used for a new (or renamed) object of `kind`, or `null`
 * when it is free.  `previous` is the object's current id during a rename;
 * `sceneId` scopes node ids to their scene.
 */
export function idUnavailableReason(
  kind: IdKind,
  id: string,
  project: EditorProject,
  options: { previous?: string; sceneId?: string } = {},
): string | null {
  const format = idFormatError(id);
  if (format !== null) return format;
  if (options.previous !== undefined && id === options.previous) return null;
  const label = ID_KIND_LABELS[kind];
  const taken = `${label} ID「${id}」已经存在。`;
  switch (kind) {
    case "scene":
      return project.scenes.some((file) => file.definition.id === id)
        ? taken
        : null;
    case "node": {
      const scene = project.scenes.find(
        (file) => file.definition.id === options.sceneId,
      );
      return scene?.definition.nodes[id] !== undefined ? taken : null;
    }
    case "variable":
      return project.manifest.variables[id] !== undefined ? taken : null;
    case "character":
      return project.manifest.characters[id] !== undefined ? taken : null;
    case "uiMotion": {
      if (project.ui_motions.some((file) => file.definition.id === id))
        return taken;
      const path = libraryFilePath("uiMotion", id);
      return project.ui_motions.some((file) => file.path === path)
        ? `文件 ${path} 已被其他 UI 动效使用。`
        : null;
    }
    case "button": {
      const buttons = project.buttons ?? [];
      if (buttons.some((file) => file.definition.id === id)) return taken;
      const path = libraryFilePath("button", id);
      return buttons.some((file) => file.path === path)
        ? `文件 ${path} 已被其他按钮模板使用。`
        : null;
    }
    case "action": {
      const actions = project.actions ?? [];
      if (
        actions.some(
          (file) =>
            file.definition.id === id &&
            file.definition.id !== options.previous,
        )
      )
        return taken;
      const owner = sharedNamespaceOwner(project, id, "action", options.previous);
      if (owner !== null)
        return `「${id}」已被${owner}使用；立绘动作不能与${owner}同名。`;
      const path = libraryFilePath("action", id);
      const previousPath = actions.find(
        (file) => file.definition.id === options.previous,
      )?.path;
      return actions.some(
        (file) => file.path === path && file.path !== previousPath,
      )
        ? `文件 ${path} 已被其他立绘动作使用。`
        : null;
    }
    case "animation":
      if (project.manifest.assets[id] !== undefined)
        return `「${id}」已被素材使用。`;
      if ((project.animations ?? []).some((file) => file.definition.id === id))
        return taken;
      return sharedNamespaceOwner(project, id, "animation") === null
        ? null
        : `「${id}」已被其他资源使用。`;
    case "textBlock":
    case "particle": {
      const owner = sharedNamespaceOwner(project, id, kind, options.previous);
      if (owner !== null) return `「${id}」已被${owner}使用。`;
      const files = kind === "textBlock" ? (project.text_blocks ?? []) : (project.particles ?? []);
      const path = libraryFilePath(kind, id);
      const previousPath = files.find((file) => file.definition.id === options.previous)?.path;
      return files.some((file) => file.path === path && file.path !== previousPath)
        ? `文件 ${path} 已被其他${label}使用。`
        : null;
    }
  }
}

/** `base`, or `base_2`, `base_3`… — the first candidate `isTaken` accepts. */
export function uniqueId(
  base: string,
  isTaken: (id: string) => boolean,
): string {
  if (!isTaken(base)) return base;
  let index = 2;
  while (isTaken(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}
