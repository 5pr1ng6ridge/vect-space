export type AssetKind =
  "background" | "sprite" | "gui" | "bgm" | "sfx" | "font";

export type ScalarValue = boolean | number | string;
export type VariableScope = "save" | "profile";
export type VariableType = "boolean" | "integer" | "number" | "string";
export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out";
export type NodeType = SceneNode["type"];

export interface VariableDefinition {
  scope: VariableScope;
  type: VariableType;
  default: ScalarValue;
}

export interface CharacterDefinition {
  display_name: string;
  name_color?: string | null;
  text_color?: string | null;
}

export type VariableOperation =
  "assign" | "add" | "sub" | "mul" | "mod" | "append" | "toggle";

export type MutationValue = ScalarValue | { variable: string };

export type ValueOperand = { variable: string } | { value: ScalarValue };

export type ConditionExpression =
  | {
      op: "eq" | "ne" | "lt" | "le" | "gt" | "ge";
      left: ValueOperand;
      right: ValueOperand;
    }
  | { op: "and" | "or"; conditions: ConditionExpression[] }
  | { op: "not"; condition: ConditionExpression };

export interface AssetDefinition {
  kind: AssetKind;
  path: string;
}

export interface ContentManifest {
  schema_version: number;
  content_version: string;
  entry_scene: string;
  default_locale: string;
  variables: Record<string, VariableDefinition>;
  characters: Record<string, CharacterDefinition>;
  assets: Record<string, AssetDefinition>;
  scenes: string[];
}

interface NextNode {
  next: string;
}

interface AwaitedNode extends NextNode {
  duration_ms: number;
  await: boolean;
}

export interface BackgroundNode extends AwaitedNode {
  type: "background";
  background: string | null;
  transition: "cut" | "cross_fade";
  easing: Easing;
}

export interface SpriteNode extends AwaitedNode {
  type: "sprite";
  sprite_id: string;
  action: "show" | "move" | "hide";
  asset: string | null;
  x: number | null;
  y: number | null;
  scale: number | null;
  opacity: number | null;
  z: number | null;
  easing: Easing;
}

export interface SayNode extends NextNode {
  type: "say";
  speaker: string | null;
  text: string;
  speed_cps: number | null;
}

export interface ChoiceDefinition {
  id: string;
  label: string;
  next: string;
  visible_if?: ConditionExpression;
  enabled_if?: ConditionExpression;
}

export interface ChoiceNode {
  type: "choice";
  choices: ChoiceDefinition[];
}

export interface SetNode extends NextNode {
  type: "set";
  variable: string;
  op?: VariableOperation;
  value?: MutationValue;
}

export interface ConditionNode {
  type: "condition";
  condition: ConditionExpression;
  then: string;
  otherwise: string;
}

export interface JumpNode {
  type: "jump";
  scene: string | null;
  target: string;
}

export interface WaitNode extends NextNode {
  type: "wait";
  duration_ms: number;
}

export interface BgmNode extends AwaitedNode {
  type: "bgm";
  action: "start" | "stop";
  asset: string | null;
  volume: number;
}

export interface SfxNode extends NextNode {
  type: "sfx";
  asset: string;
  volume: number;
}

export interface CameraNode extends AwaitedNode {
  type: "camera";
  x: number;
  y: number;
  zoom: number;
  easing: Easing;
}

export interface ScreenEffectNode extends AwaitedNode {
  type: "screen_effect";
  effect: "shake" | "flash";
}

export interface DialogueUiNode extends AwaitedNode {
  type: "dialogue_ui";
  visible: boolean;
}

export interface EndNode {
  type: "end";
}

export type SceneNode =
  | BackgroundNode
  | SpriteNode
  | SayNode
  | ChoiceNode
  | SetNode
  | ConditionNode
  | JumpNode
  | WaitNode
  | BgmNode
  | SfxNode
  | CameraNode
  | ScreenEffectNode
  | DialogueUiNode
  | EndNode;

export interface SceneDefinition {
  schema_version: number;
  id: string;
  entry: string;
  nodes: Record<string, SceneNode>;
}

export interface EditorSceneFile {
  path: string;
  definition: SceneDefinition;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface EditorViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SceneLayout {
  nodes: Record<string, NodePosition>;
  viewport: EditorViewport | null;
}

export interface EditorLayout {
  version: number;
  scenes: Record<string, SceneLayout>;
}

export interface EditorAsset {
  id: string;
  kind: AssetKind;
  path: string;
  absolute_path: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface EditorDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  scene_id: string | null;
  node_id: string | null;
}

export interface EditorProject {
  root: string;
  manifest: ContentManifest;
  scenes: EditorSceneFile[];
  layout: EditorLayout;
  assets: EditorAsset[];
  diagnostics: EditorDiagnostic[];
  fingerprint: string;
}

export interface SaveProjectRequest {
  manifest: ContentManifest;
  scenes: EditorSceneFile[];
  layout: EditorLayout;
  expected_fingerprint: string;
}

export interface StoryLocation {
  scene_id: string;
  node_id: string;
}

export interface SpriteSnapshot {
  asset: string;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  z: number;
}

export type PromptSnapshot =
  | { kind: "none" }
  | {
      kind: "dialogue";
      prompt_id: string;
      speaker: string | null;
      speaker_id?: string | null;
      name_color?: string | null;
      text_color?: string | null;
      text: string;
    }
  | {
      kind: "choice";
      prompt_id: string;
      choices: { id: string; label: string; enabled: boolean }[];
    }
  | { kind: "end"; prompt_id: string };

export interface RuntimeSnapshot {
  revision: number;
  location: StoryLocation;
  variables: Record<string, ScalarValue>;
  world: {
    background: string | null;
    sprites: Record<string, SpriteSnapshot>;
    camera: { x: number; y: number; zoom: number };
    dialogue_ui_visible: boolean;
    persistent_effects: string[];
  };
  audio: { bgm: { asset: string; volume: number } | null };
  prompt: PromptSnapshot;
}

export interface RuntimeUpdate {
  update_id: number;
  snapshot: RuntimeSnapshot;
  cues: ({
    cue_id: number;
    gate: "none" | "player_advance" | "runtime";
  } & Record<string, unknown>)[];
  requires_ack: boolean;
}

export interface ImportedAsset {
  id: string;
  kind: AssetKind;
  path: string;
  absolute_path: string;
}
