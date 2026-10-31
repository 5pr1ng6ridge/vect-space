import { createContext } from "react";
import type { ContentManifest, SceneDefinition } from "../../types";

/**
 * Inspector title: what the node is, its stable id (renamable in place) and
 * every node-level action in one menu, instead of a column of buttons.
 */
/** Scene data shared with deeply nested field editors. */
export const InspectorSceneContext = createContext<{
  scene: SceneDefinition;
  manifest: ContentManifest;
  onLocate?(nodeId: string): void;
} | null>(null);
