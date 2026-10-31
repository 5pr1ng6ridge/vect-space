import type {
  AnimationFile,
  ActionFile,
  ContentManifest,
  EditorAsset,
  ScalarValue,
  SceneDefinition,
  SceneNode,
  UiMotionFile,
  ButtonFile,
  EditorProject,
  PreviewChoiceDecision,
} from "../../types";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type { ChoicePrompt } from "@vectspace/presentation-core/types";
import type { CuePreviewEnvironment } from "../CuePreview";

/** Preview inputs threaded to the Rust-backed inspector previews. */
export interface NodePreviewContext {
  project: EditorProject;
  animationMap: AnimationMap;
  importTokens: string[];
  variableOverrides: Record<string, ScalarValue>;
  choices: PreviewChoiceDecision[];
  onResolvedPrompt(prompt: ChoicePrompt | null): void;
}

export interface FieldsContext {
  nodeId: string;
  update: (node: SceneNode) => void;
  scene: SceneDefinition;
  manifest: ContentManifest;
  uiMotions: UiMotionFile[];
  buttons: ButtonFile[];
  assets: readonly EditorAsset[];
  animations: readonly AnimationFile[];
  actions: readonly ActionFile[];
  scenes: SceneDefinition[];
  onError: ((message: string) => void) | undefined;
  previewEnvironment: CuePreviewEnvironment | undefined;
  splitDialogue: (offset: number, text?: string) => void;
  splitLongText: (stepIndex: number) => void;
  openLongTextWorkspace: () => void;
  preview: NodePreviewContext | undefined;
  choicePreviewPrompt: ChoicePrompt | null;
  targets: string[];
}

export type NodeOf<T extends SceneNode["type"]> = Extract<
  SceneNode,
  { type: T }
>;
