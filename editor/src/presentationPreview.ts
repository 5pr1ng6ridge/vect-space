/**
 * Pure request builders for the inspector's one-shot presentation previews.
 *
 * The previews themselves only apply pixels; every value they apply (the
 * before/after world, the cue parameters, the authored duration) is derived
 * here so the same pure builders can be unit tested without Pixi and the
 * React component stays a thin adapter.
 */

import type {
  SceneVisualCue,
  SceneWorldSnapshot,
} from "@vectspace/presentation-core/scene-surface";
import type { CurtainSnapshot } from "@vectspace/presentation-core/types";

import { outputPorts } from "./story";
import type {
  BackgroundNode,
  CurtainNode,
  SceneDefinition,
  SceneNode,
  ScreenEffectNode,
} from "./types";

/** World state a node sees when the runtime first arrives at it. */
export interface StoryVisualState {
  background: string | null;
  curtain: CurtainSnapshot;
}

/** One deterministic preview run: a before-world plus the cue to apply. */
export interface CuePreviewRequest {
  world: SceneWorldSnapshot;
  cue: SceneVisualCue;
  /** Authored cue duration, used by the seek slider. */
  duration_ms: number;
}

const DEFAULT_CAMERA = {
  x: 0,
  y: 0,
  zoom: 1,
  rotation_deg: 0,
};

const NO_CURTAIN: CurtainSnapshot = { covered: false, fill: null };

function stateAfterNode(
  node: SceneNode,
  state: StoryVisualState,
): StoryVisualState {
  switch (node.type) {
    case "background":
      return { ...state, background: node.background };
    case "clear":
      return { ...state, background: null };
    case "curtain":
      return {
        ...state,
        curtain:
          node.action === "cover"
            ? { covered: true, fill: node.fill ?? null }
            : NO_CURTAIN,
      };
    default:
      return state;
  }
}

/**
 * The visual state in effect when the runtime first reaches `nodeId`.
 *
 * The walk is a breadth-first first-visit search from the scene entry, so it
 * is deterministic (the same graph always yields the same answer) and mirrors
 * the first path a playthrough would take; branches are not simulated, which
 * is exactly the precision an authoring preview needs.  Unreachable nodes get
 * an empty state.
 */
export function storyVisualStateAtNode(
  scene: SceneDefinition,
  nodeId: string,
): StoryVisualState {
  const empty: StoryVisualState = { background: null, curtain: NO_CURTAIN };
  if (scene.nodes[nodeId] === undefined) return empty;
  const visited = new Set<string>();
  const queue: { id: string; state: StoryVisualState }[] = [
    { id: scene.entry, state: empty },
  ];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.id === nodeId) return current.state;
    const node = scene.nodes[current.id];
    if (node === undefined) continue;
    const nextState = stateAfterNode(node, current.state);
    for (const port of outputPorts(node)) {
      if (port.targetScene !== null) continue;
      if (scene.nodes[port.target] === undefined) continue;
      if (port.target === nodeId) return nextState;
      queue.push({ id: port.target, state: nextState });
    }
  }
  return empty;
}

/** The "before" world a background node transitions away from. */
export function buildBackgroundPreviewRequest(
  node: BackgroundNode,
  state: StoryVisualState,
): CuePreviewRequest {
  return {
    world: {
      background: state.background,
      sprites: {},
      camera: { ...DEFAULT_CAMERA },
      curtain: state.curtain,
    },
    cue: {
      cue_id: "preview",
      gate: "none",
      type: "background_transition",
      background: node.background,
      transition: node.transition,
      duration_ms: node.duration_ms,
      easing: node.easing,
    },
    duration_ms: node.duration_ms,
  };
}

/** The "before" world a curtain node covers/reveals. */
export function buildCurtainPreviewRequest(
  node: CurtainNode,
  state: StoryVisualState,
): CuePreviewRequest {
  return {
    world: {
      background: state.background,
      sprites: {},
      camera: { ...DEFAULT_CAMERA },
      curtain: state.curtain,
    },
    cue: {
      cue_id: "preview",
      gate: "none",
      type: "curtain_transition",
      action: node.action,
      fill: node.action === "cover" ? (node.fill ?? null) : null,
      transition: node.transition,
      duration_ms: node.duration_ms,
      easing: node.easing,
    },
    duration_ms: node.duration_ms,
  };
}

/** The world a screen effect shakes/flashes over. */
export function buildScreenEffectPreviewRequest(
  node: ScreenEffectNode,
  state: StoryVisualState,
): CuePreviewRequest {
  return {
    world: {
      background: state.background,
      sprites: {},
      camera: { ...DEFAULT_CAMERA },
      curtain: state.curtain,
    },
    cue: {
      cue_id: "preview",
      gate: "none",
      type: "screen_effect",
      effect: node.effect,
      duration_ms: node.duration_ms,
    },
    duration_ms: node.duration_ms,
  };
}
