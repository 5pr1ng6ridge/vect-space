import type {
  ButtonFile,
  ConditionExpression,
  ContentManifest,
  ScalarValue,
  SceneDefinition,
  SceneNode,
} from "../types";
import { defaultBackgroundTransition } from "../presentationDefaults";
import { removeUnknownTemplateVariables } from "../textTemplate";
import { WINDOW_TITLE_VARIABLES } from "../windowInteraction";
import { COLOR_PATTERN } from "../validation/shared";

export function emitterInstanceIds(
  scenes: readonly SceneDefinition[],
  copies: readonly SceneNode[] = [],
): Set<string> {
  const used = new Set<string>();
  for (const node of [
    ...scenes.flatMap((scene) => Object.values(scene.nodes)),
    ...copies,
  ]) {
    if (node.type === "particle") used.add(node.emitter_id);
    if (node.type === "timeline") {
      for (const track of node.tracks) {
        if (track.type === "emitter") used.add(track.emitter_id);
      }
    }
  }
  return used;
}

export function uniqueEmitterId(
  used: ReadonlySet<string>,
  prefix = "emitter",
): string {
  let id = prefix;
  let index = 2;
  while (used.has(id)) id = `${prefix}_${index++}`;
  return id;
}

/** Remap detached copies as one batch so their internal emitter controls stay together. */
export function remapCopiedEmitterInstances(
  nodes: readonly SceneNode[],
  scenes: readonly SceneDefinition[],
): void {
  const used = emitterInstanceIds(scenes, nodes);
  const copiedIds = new Map<string, string>();
  for (const node of nodes) {
    if (node.type !== "particle" || node.action !== "start") continue;
    if (copiedIds.has(node.emitter_id)) continue;
    const id = uniqueEmitterId(used, node.emitter_id || "emitter");
    copiedIds.set(node.emitter_id, id);
    used.add(id);
  }
  for (const node of nodes) {
    if (node.type === "particle") {
      node.emitter_id = copiedIds.get(node.emitter_id) ?? node.emitter_id;
    } else if (node.type === "timeline") {
      for (const track of node.tracks) {
        if (track.type === "emitter") {
          track.emitter_id =
            copiedIds.get(track.emitter_id) ?? track.emitter_id;
        }
      }
    }
  }
}

/**
 * Prepare one copied node for insertion as an independent graph node.
 * Flow edges never cross the clipboard boundary. References that no longer
 * exist in the destination project are intentionally emptied so the editor can
 * surface them as ordinary, fixable diagnostics.
 */
export function preparePastedNode(
  source: SceneNode,
  manifest: ContentManifest,
  sourceCharacterId: string | null = null,
  buttons: readonly ButtonFile[] = [],
): SceneNode {
  const node = structuredClone(source);
  // Variables a template or condition operand may read (the read-only window
  // title variables are always available); `set` still writes manifest ones.
  const writableVariables = new Set(Object.keys(manifest.variables));
  const variables = new Set([...writableVariables, ...WINDOW_TITLE_VARIABLES]);
  const hasAsset = (id: string | null | undefined, kind: string): boolean =>
    id != null && manifest.assets[id]?.kind === kind;
  const hasButton = (id: string | null | undefined): boolean =>
    id != null && buttons.some((file) => file.definition.id === id);
  const clearOperand = (
    operand: { variable: string } | { value: ScalarValue },
  ): { variable: string } | { value: ScalarValue } =>
    "variable" in operand && !variables.has(operand.variable)
      ? { variable: "" }
      : operand;
  const clearCondition = (
    condition: ConditionExpression,
  ): ConditionExpression => {
    switch (condition.op) {
      case "eq":
      case "ne":
      case "lt":
      case "le":
      case "gt":
      case "ge":
        return {
          ...condition,
          left: clearOperand(condition.left),
          right: clearOperand(condition.right),
        };
      case "and":
      case "or":
        return {
          ...condition,
          conditions: condition.conditions.map(clearCondition),
        };
      case "not":
        return { ...condition, condition: clearCondition(condition.condition) };
    }
  };

  if ("next" in node) node.next = "";
  if (node.type === "proof") delete node.abandon;
  switch (node.type) {
    case "background":
      if (node.background !== null && !hasAsset(node.background, "background"))
        node.background = null;
      if (
        node.transition.type === "fade_through_color" &&
        !COLOR_PATTERN.test(node.transition.color)
      ) {
        node.transition = defaultBackgroundTransition();
      }
      break;
    case "curtain":
      if (
        node.fill != null &&
        "asset" in node.fill &&
        !hasAsset(node.fill.asset, "gui")
      ) {
        node.fill = null;
      }
      break;
    case "sprite":
      if (node.asset != null && !hasAsset(node.asset, "sprite"))
        node.asset = null;
      break;
    case "say":
      if (
        sourceCharacterId !== null &&
        manifest.characters[sourceCharacterId] === undefined
      ) {
        node.speaker = null;
      }
      node.text = removeUnknownTemplateVariables(node.text, variables);
      break;
    case "choice":
      node.choices = node.choices.map((choice) => ({
        ...choice,
        label: removeUnknownTemplateVariables(choice.label, variables),
        next: "",
        ...(hasButton(choice.template) ? {} : { template: null }),
        ...(hasAsset(choice.icon, "gui") ? {} : { icon: null }),
        ...(choice.visible_if === undefined
          ? {}
          : { visible_if: clearCondition(choice.visible_if) }),
        ...(choice.enabled_if === undefined
          ? {}
          : { enabled_if: clearCondition(choice.enabled_if) }),
      }));
      if (node.presentation != null && !hasButton(node.presentation.template)) {
        node.presentation = { ...node.presentation, template: null };
      }
      break;
    case "set":
      if (!writableVariables.has(node.variable)) node.variable = "";
      if (
        typeof node.value === "object" &&
        node.value !== null &&
        !variables.has(node.value.variable)
      ) {
        node.value = { variable: "" };
      }
      break;
    case "condition":
      node.condition = clearCondition(node.condition);
      node.then = "";
      node.otherwise = "";
      break;
    case "jump":
      node.scene = null;
      node.target = "";
      break;
    case "open_window":
      node.scene = "";
      break;
    case "window_title":
      node.title = removeUnknownTemplateVariables(node.title, variables);
      break;
    case "window_control":
      if (node.message !== undefined && node.message !== "") {
        node.message = removeUnknownTemplateVariables(node.message, variables);
      }
      break;
    case "timer":
      // The effect target is a node of the *source* Scene; like flow edges it
      // never crosses the clipboard boundary on its own.
      if (node.target != null) node.target = null;
      break;
    case "bgm":
      if (node.asset !== null && !hasAsset(node.asset, "bgm"))
        node.asset = null;
      break;
    case "ambience":
      if (node.asset != null && !hasAsset(node.asset, "ambience"))
        node.asset = null;
      break;
    case "sfx":
      if (!hasAsset(node.asset, "sfx")) node.asset = "";
      break;
    case "timeline":
      node.tracks = node.tracks.map((track) => {
        if (
          track.type === "sprite" &&
          track.asset !== null &&
          !hasAsset(track.asset, "sprite")
        )
          return { ...track, asset: null };
        if (track.type === "video" && !hasAsset(track.asset, "video"))
          return { ...track, asset: "" };
        return track;
      });
      node.events = node.events.map((event) =>
        event.type === "sfx" && !hasAsset(event.asset, "sfx")
          ? { ...event, asset: "" }
          : event,
      );
      break;
    case "playback":
    case "wait":
    case "clear":
    case "camera":
    case "screen_effect":
    case "dialogue_ui":
    case "ui_motion_set":
    case "ui_motion_play":
    case "end":
      break;
  }
  return node;
}
