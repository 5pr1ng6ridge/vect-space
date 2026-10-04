/**
 * Authoring rules for the two-window story features: Scene purpose
 * (`window_role`), the built-in window title variables, and Scene timers.
 *
 * Everything here mirrors `vectspace-core` (`interaction.rs` and the content
 * validator) so the editor can explain a problem while the author is still
 * typing.  The Rust loader remains the authority.
 */
import type {
  ContentManifest,
  SceneDefinition,
  SceneNode,
  VariableDefinition,
  WindowRole,
} from "./types";

export const MAIN_TITLE_VARIABLE = "window.main.title";
export const SECONDARY_TITLE_VARIABLE = "window.secondary.title";
export const WINDOW_TITLE_VARIABLES: readonly string[] = [
  MAIN_TITLE_VARIABLE,
  SECONDARY_TITLE_VARIABLE,
];

export const MIN_TIMER_INTERVAL_MS = 50;
export const MAX_SCENE_TIMERS = 64;
/** Same cap as every other animation duration. */
export const MAX_TIMER_DURATION_MS = 60_000;
export const MAX_WINDOW_TITLE_BYTES = 4096;

export const WINDOW_ROLE_LABELS: Record<WindowRole, string> = {
  main: "主窗口",
  secondary: "副窗口",
};

/** Built-in, read-only string variables maintained by `window_title` nodes. */
export const WINDOW_VARIABLE_DEFINITIONS: Readonly<
  Record<string, VariableDefinition>
> = {
  [MAIN_TITLE_VARIABLE]: { scope: "save", type: "string", default: "" },
  [SECONDARY_TITLE_VARIABLE]: { scope: "save", type: "string", default: "" },
};

export const WINDOW_VARIABLE_LABELS: Readonly<Record<string, string>> = {
  [MAIN_TITLE_VARIABLE]: "主窗口标题",
  [SECONDARY_TITLE_VARIABLE]: "副窗口标题",
};

export function isWindowVariable(id: string): boolean {
  return WINDOW_TITLE_VARIABLES.includes(id);
}

/** Variables a condition, an operand or a `[var=…]` reference may read. */
export function readableVariables(
  manifest: Pick<ContentManifest, "variables">,
): Record<string, VariableDefinition> {
  return { ...WINDOW_VARIABLE_DEFINITIONS, ...manifest.variables };
}

export function sceneRole(
  scene: Pick<SceneDefinition, "window_role"> | undefined,
): WindowRole {
  return scene?.window_role ?? "main";
}

/**
 * Node types whose *effect* a timer may run.  Mirrors
 * `interaction::timer_target_allowed`: only non-blocking nodes, never anything
 * that moves the story or schedules again.
 */
export function timerTargetAllowed(node: SceneNode): boolean {
  switch (node.type) {
    case "set":
    case "sfx":
    case "window_title":
    case "window_control":
    case "window_layer":
      return true;
    case "background":
    case "sprite":
    case "action":
    case "timeline":
    case "bgm":
    case "ambience":
    case "camera":
    case "screen_effect":
    case "curtain":
    case "ui_motion_play":
    case "window_geometry":
      return !node.await;
    default:
      return false;
  }
}

/** Why `node` cannot be a timer target, or `null` when it can. */
export function timerTargetProblem(node: SceneNode | undefined): string | null {
  if (node === undefined) return "目标节点不存在";
  if (timerTargetAllowed(node)) return null;
  if ("await" in node && node.await)
    return "目标节点开启了「等待完成」；计时器只能运行不会阻塞剧情的效果";
  return `「${node.type}」节点会改变剧情位置或再次调度，不能作为计时器目标`;
}

/** Sorted ids of the nodes in `scene` a timer may run. */
export function validTimerTargets(scene: SceneDefinition): string[] {
  return Object.entries(scene.nodes)
    .filter(([, node]) => timerTargetAllowed(node))
    .map(([id]) => id)
    .sort();
}

/**
 * A non-flow reference from one node to another node of the same Scene.
 * Today only a starting timer has one (its effect target); it is not a story
 * edge, so `outputPorts` never reports it.
 */
export interface EffectReference {
  id: string;
  label: string;
  target: string;
}

export const EFFECT_HANDLE = "effect";

export function effectReferences(node: SceneNode): EffectReference[] {
  if (
    node.type === "timer" &&
    node.action === "start" &&
    node.target != null &&
    node.target !== ""
  ) {
    return [{ id: EFFECT_HANDLE, label: "触发效果", target: node.target }];
  }
  return [];
}

/** Retarget one effect reference; unknown handles leave the node unchanged. */
export function setEffectReferenceTarget(
  node: SceneNode,
  handle: string,
  target: string | null,
): SceneNode {
  if (node.type === "timer" && handle === EFFECT_HANDLE) {
    return { ...node, target };
  }
  return node;
}

/** `value`, or `fallback` when it is missing or empty. */
export function nonEmpty(
  value: string | null | undefined,
  fallback: string,
): string {
  return value === undefined || value === null || value === ""
    ? fallback
    : value;
}

/** UTF-8 length used for the native-title byte limit. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Problem with a window title string, or `null` when it is acceptable. */
export function windowTitleProblem(title: string): string | null {
  if (utf8Length(title) > MAX_WINDOW_TITLE_BYTES)
    return `窗口标题不能超过 ${MAX_WINDOW_TITLE_BYTES} 字节`;
  if (/\p{Cc}/u.test(title)) return "窗口标题不能包含控制字符";
  return null;
}

/**
 * The effect port a node *offers*, whether or not it points anywhere yet, so
 * the graph can draw a connectable handle for a freshly added timer.
 */
export function effectPorts(node: SceneNode): EffectReference[] {
  if (node.type === "timer" && node.action === "start") {
    return [
      { id: EFFECT_HANDLE, label: "触发效果", target: node.target ?? "" },
    ];
  }
  return [];
}
