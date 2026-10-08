import type { SceneNode } from "../types";
import { EFFECT_HANDLE, setEffectReferenceTarget } from "../windowInteraction";

interface OutputPort {
  id: string;
  label: string;
  target: string;
  targetScene: string | null;
}

export function outputPorts(node: SceneNode): OutputPort[] {
  switch (node.type) {
    case "choice":
      return node.choices.map((choice) => ({
        id: `choice:${choice.id}`,
        label: choice.label || choice.id,
        target: choice.next,
        targetScene: null,
      }));
    case "condition":
      return [
        { id: "then", label: "成立", target: node.then, targetScene: null },
        {
          id: "otherwise",
          label: "否则",
          target: node.otherwise,
          targetScene: null,
        },
      ];
    case "jump":
      return [
        {
          id: "jump",
          label: node.scene === null ? "跳转" : `跳转 ${node.scene}`,
          target: node.target,
          targetScene: node.scene,
        },
      ];
    case "end":
      return [];
    default:
      return [
        { id: "next", label: "下一步", target: node.next, targetScene: null },
      ];
  }
}

export function setPortTarget(
  node: SceneNode,
  handle: string,
  target: string,
): SceneNode {
  if (handle === "next" && "next" in node) {
    return { ...node, next: target };
  }
  if (
    node.type === "condition" &&
    (handle === "then" || handle === "otherwise")
  ) {
    return { ...node, [handle]: target };
  }
  if (node.type === "jump" && handle === "jump") {
    return { ...node, scene: null, target };
  }
  if (handle === EFFECT_HANDLE) {
    return setEffectReferenceTarget(node, handle, target);
  }
  if (node.type === "choice" && handle.startsWith("choice:")) {
    const choiceId = handle.slice("choice:".length);
    return {
      ...node,
      choices: node.choices.map((choice) =>
        choice.id === choiceId ? { ...choice, next: target } : choice,
      ),
    };
  }
  return node;
}
