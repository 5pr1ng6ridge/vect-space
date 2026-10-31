import type {
  ConditionExpression,
  EditorProject,
  ScalarValue,
  TimelinePreviewSettings,
} from "../types";
import { countTemplateVariable, renameTemplateVariable } from "../textTemplate";
import { renameNodeInGroups } from "../components/graphGroups";
import {
  effectReferences,
  setEffectReferenceTarget,
} from "../windowInteraction";
import { cloneProject, findScene } from "./project";
import { outputPorts, setPortTarget } from "./ports";

export function renameVariable(
  project: EditorProject,
  previousId: string,
  nextId: string,
): EditorProject {
  if (
    project.manifest.variables[previousId] === undefined ||
    project.manifest.variables[nextId] !== undefined
  ) {
    return project;
  }
  const updated = cloneProject(project);
  const definition = updated.manifest.variables[previousId];
  Reflect.deleteProperty(updated.manifest.variables, previousId);
  updated.manifest.variables[nextId] = definition;
  for (const file of updated.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "set" && node.variable === previousId) {
        node.variable = nextId;
      }
      if (
        node.type === "set" &&
        typeof node.value === "object" &&
        node.value !== null &&
        node.value.variable === previousId
      ) {
        node.value.variable = nextId;
      }
      if (node.type === "say") {
        node.text = renameTemplateVariable(node.text, previousId, nextId);
      }
      if (node.type === "window_title") {
        node.title = renameTemplateVariable(node.title, previousId, nextId);
      }
      if (node.type === "window_control" && node.message !== undefined) {
        node.message = renameTemplateVariable(node.message, previousId, nextId);
      }
      if (node.type === "condition") {
        node.condition = mapConditionVariables(
          node.condition,
          previousId,
          nextId,
        );
      }
      if (node.type === "choice") {
        for (const choice of node.choices) {
          choice.label = renameTemplateVariable(
            choice.label,
            previousId,
            nextId,
          );
          if (choice.visible_if !== undefined) {
            choice.visible_if = mapConditionVariables(
              choice.visible_if,
              previousId,
              nextId,
            );
          }
          if (choice.enabled_if !== undefined) {
            choice.enabled_if = mapConditionVariables(
              choice.enabled_if,
              previousId,
              nextId,
            );
          }
        }
      }
    }
  }
  for (const settings of Object.values(
    updated.layout.timeline_previews ?? {},
  )) {
    if (
      Object.prototype.hasOwnProperty.call(
        settings.variable_overrides,
        previousId,
      )
    ) {
      settings.variable_overrides[nextId] =
        settings.variable_overrides[previousId];
      Reflect.deleteProperty(settings.variable_overrides, previousId);
    }
  }
  return updated;
}

export function countVariableReferences(
  project: EditorProject,
  variableId: string,
): number {
  let count = 0;
  for (const file of project.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "set" && node.variable === variableId) count += 1;
      if (
        node.type === "set" &&
        typeof node.value === "object" &&
        node.value !== null &&
        node.value.variable === variableId
      ) {
        count += 1;
      }
      if (node.type === "say") {
        count += countTemplateVariable(node.text, variableId);
      }
      if (node.type === "window_title") {
        count += countTemplateVariable(node.title, variableId);
      }
      if (node.type === "window_control" && node.message !== undefined) {
        count += countTemplateVariable(node.message, variableId);
      }
      if (node.type === "condition") {
        count += countConditionReferences(node.condition, variableId);
      }
      if (node.type === "choice") {
        for (const choice of node.choices) {
          count += countTemplateVariable(choice.label, variableId);
          if (choice.visible_if !== undefined) {
            count += countConditionReferences(choice.visible_if, variableId);
          }
          if (choice.enabled_if !== undefined) {
            count += countConditionReferences(choice.enabled_if, variableId);
          }
        }
      }
    }
  }
  return count;
}

export function renameCharacter(
  project: EditorProject,
  previousId: string,
  nextId: string,
): EditorProject {
  if (
    project.manifest.characters[previousId] === undefined ||
    project.manifest.characters[nextId] !== undefined
  ) {
    return project;
  }
  const updated = cloneProject(project);
  const definition = updated.manifest.characters[previousId];
  Reflect.deleteProperty(updated.manifest.characters, previousId);
  updated.manifest.characters[nextId] = definition;
  for (const file of updated.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "say" && node.speaker === previousId) {
        node.speaker = nextId;
      }
      if (node.type === "sprite" && node.character === previousId) {
        node.character = nextId;
      }
    }
  }
  return updated;
}

export function countCharacterReferences(
  project: EditorProject,
  characterId: string,
): number {
  let count = 0;
  for (const file of project.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "say" && node.speaker === characterId) count += 1;
      if (node.type === "sprite" && node.character === characterId) count += 1;
    }
  }
  return count;
}

function mapConditionVariables(
  condition: ConditionExpression,
  previousId: string,
  nextId: string,
): ConditionExpression {
  switch (condition.op) {
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
      return {
        ...condition,
        left: renameOperand(condition.left, previousId, nextId),
        right: renameOperand(condition.right, previousId, nextId),
      };
    case "and":
    case "or":
      return {
        ...condition,
        conditions: condition.conditions.map((child) =>
          mapConditionVariables(child, previousId, nextId),
        ),
      };
    case "not":
      return {
        ...condition,
        condition: mapConditionVariables(
          condition.condition,
          previousId,
          nextId,
        ),
      };
  }
}

function renameOperand(
  operand: { variable: string } | { value: ScalarValue },
  previousId: string,
  nextId: string,
) {
  return "variable" in operand && operand.variable === previousId
    ? { variable: nextId }
    : operand;
}

function countConditionReferences(
  condition: ConditionExpression,
  variableId: string,
): number {
  switch (condition.op) {
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
      return [condition.left, condition.right].filter(
        (operand) => "variable" in operand && operand.variable === variableId,
      ).length;
    case "and":
    case "or":
      return condition.conditions.reduce(
        (total, child) => total + countConditionReferences(child, variableId),
        0,
      );
    case "not":
      return countConditionReferences(condition.condition, variableId);
  }
}

export function renameNode(
  project: EditorProject,
  sceneId: string,
  previousId: string,
  nextId: string,
): EditorProject {
  const updated = cloneProject(project);
  const targetScene = findScene(updated, sceneId);
  if (targetScene === undefined) {
    return project;
  }
  const node = targetScene.definition.nodes[previousId];
  if (
    node === undefined ||
    targetScene.definition.nodes[nextId] !== undefined
  ) {
    return project;
  }
  Reflect.deleteProperty(targetScene.definition.nodes, previousId);
  targetScene.definition.nodes[nextId] = node;
  if (targetScene.definition.entry === previousId) {
    targetScene.definition.entry = nextId;
  }

  // An unnamed start long-text uses its node ID as the document ID. Renaming
  // that node therefore changes the document's effective ID; keep local
  // continuation/control references valid instead of leaving a hidden stale
  // document reference behind.
  if (
    node.type === "long_text" &&
    (node.mode ?? "start") === "start" &&
    (node.document === undefined || node.document === null)
  ) {
    for (const [candidateId, candidate] of Object.entries(
      targetScene.definition.nodes,
    )) {
      if (candidateId === nextId) continue;
      if (
        (candidate.type === "long_text" ||
          candidate.type === "long_text_control") &&
        candidate.document === previousId
      ) {
        targetScene.definition.nodes[candidateId] = {
          ...candidate,
          document: nextId,
        };
      }
    }
  }

  for (const file of updated.scenes) {
    for (const [nodeId, candidate] of Object.entries(file.definition.nodes)) {
      let changed = candidate;
      if (file.definition.id === sceneId) {
        for (const port of outputPorts(candidate)) {
          if (port.targetScene === null && port.target === previousId) {
            changed = setPortTarget(changed, port.id, nextId);
          }
        }
        // Timer effect targets are references, not flow edges.
        for (const reference of effectReferences(changed)) {
          if (reference.target === previousId) {
            changed = setEffectReferenceTarget(changed, reference.id, nextId);
          }
        }
      }
      if (
        changed.type === "jump" &&
        (changed.scene ?? file.definition.id) === sceneId &&
        changed.target === previousId
      ) {
        changed = { ...changed, target: nextId };
      }
      file.definition.nodes[nodeId] = changed;
    }
  }

  const sceneLayout = updated.layout.scenes[sceneId];
  if (sceneLayout?.nodes[previousId] !== undefined) {
    sceneLayout.nodes[nextId] = sceneLayout.nodes[previousId];
    Reflect.deleteProperty(sceneLayout.nodes, previousId);
  }
  if (sceneLayout?.groups !== undefined)
    sceneLayout.groups = renameNodeInGroups(
      sceneLayout.groups,
      previousId,
      nextId,
      new Set(Object.keys(targetScene.definition.nodes)),
    );
  const previews = updated.layout.timeline_previews;
  if (previews !== undefined) {
    const oldKey = `${sceneId}/${previousId}`;
    const newKey = `${sceneId}/${nextId}`;
    if (previews[oldKey] !== undefined) {
      previews[newKey] = previews[oldKey];
      Reflect.deleteProperty(previews, oldKey);
    }
    migratePreviewChoices(previews, (choice) =>
      choice.scene_id === sceneId && choice.node_id === previousId
        ? { ...choice, node_id: nextId }
        : choice,
    );
  }
  return updated;
}

export function renameScene(
  project: EditorProject,
  previousId: string,
  nextId: string,
): EditorProject {
  const updated = cloneProject(project);
  const scene = findScene(updated, previousId);
  if (scene === undefined || findScene(updated, nextId) !== undefined) {
    return project;
  }
  scene.definition.id = nextId;
  const oldPath = scene.path;
  const newPath = `scenes/${nextId}.yaml`;
  scene.path = newPath;
  updated.manifest.scenes = updated.manifest.scenes.map((path) =>
    path === oldPath ? newPath : path,
  );
  if (updated.manifest.entry_scene === previousId) {
    updated.manifest.entry_scene = nextId;
  }
  for (const file of updated.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "jump" && node.scene === previousId) {
        node.scene = nextId;
      }
      if (node.type === "open_window" && node.scene === previousId) {
        node.scene = nextId;
      }
    }
  }
  if (updated.layout.scenes[previousId] !== undefined) {
    updated.layout.scenes[nextId] = updated.layout.scenes[previousId];
    Reflect.deleteProperty(updated.layout.scenes, previousId);
  }
  if (updated.chapter_map !== null && updated.chapter_map !== undefined) {
    for (const hotspot of updated.chapter_map.definition.hotspots) {
      if (hotspot.scene_id === previousId) hotspot.scene_id = nextId;
    }
  }
  const previews = updated.layout.timeline_previews;
  if (previews !== undefined) {
    for (const key of Object.keys(previews)) {
      if (key.startsWith(`${previousId}/`)) {
        previews[`${nextId}/${key.slice(previousId.length + 1)}`] =
          previews[key];
        Reflect.deleteProperty(previews, key);
      }
    }
    migratePreviewChoices(previews, (choice) =>
      choice.scene_id === previousId ? { ...choice, scene_id: nextId } : choice,
    );
  }
  return updated;
}

/** Rename a reusable sprite action and keep every scene reference/file path in
 * sync.  The caller performs user-facing validation; returning the original
 * project makes this helper safe to use from an editor reducer when a race
 * caused the source action to disappear. */
export function renameSpriteAction(
  project: EditorProject,
  previousId: string,
  nextId: string,
): EditorProject {
  const updated = cloneProject(project);
  const action = (updated.actions ?? []).find(
    (file) => file.definition.id === previousId,
  );
  if (
    action === undefined ||
    previousId === nextId ||
    (updated.actions ?? []).some((file) => file.definition.id === nextId) ||
    updated.manifest.assets[nextId] !== undefined ||
    (updated.animations ?? []).some((file) => file.definition.id === nextId)
  ) {
    return project;
  }
  const oldPath = action.path;
  const newPath = `actions/${nextId.replaceAll(".", "_")}.yaml`;
  if (
    (updated.actions ?? []).some(
      (file) => file !== action && file.path === newPath,
    )
  ) {
    return project;
  }
  action.definition.id = nextId;
  action.path = newPath;
  updated.manifest.actions = (updated.manifest.actions ?? []).map((path) =>
    path === oldPath ? newPath : path,
  );
  for (const scene of updated.scenes) {
    for (const node of Object.values(scene.definition.nodes)) {
      if (node.type === "action" && node.action === previousId) {
        node.action = nextId;
      }
    }
  }
  return updated;
}

function migratePreviewChoices(
  previews: Record<string, TimelinePreviewSettings>,
  migrate: (
    choice: TimelinePreviewSettings["choices"][number],
  ) => TimelinePreviewSettings["choices"][number],
): void {
  for (const settings of Object.values(previews)) {
    settings.choices = settings.choices.map(migrate);
  }
}
