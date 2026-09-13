/**
 * Authoring helpers for template-driven choice presentation.
 *
 * The runtime owns the resolved layout; the editor only needs the same pure
 * placement rules to seed a sensible anchor when an author first opts a legacy
 * node into `presentation`, and to preview the sizes every option resolves to.
 * Both directions reuse the shared `choice-layout` mirror of the Rust layout,
 * so an editor-created presentation never disagrees with the runtime.
 */

import {
  CHOICE_DEFAULT_ANCHOR_X,
  CHOICE_DEFAULT_ANCHOR_Y,
  CHOICE_DEFAULT_GAP,
  legacyChoiceAnchor,
  resolveChoiceItemSize,
} from "@vectspace/presentation-core/choice-layout";

import type { ChoicePrompt } from "@vectspace/presentation-core/types";

import type {
  ButtonFile,
  ChoiceDefinition,
  ChoiceFlowDirection,
  ChoiceNode,
  ChoicePresentation,
  ContentManifest,
} from "./types";

export interface ChoiceItemSize {
  width: number;
  height: number;
}

function templateSize(
  buttons: readonly ButtonFile[],
  templateId: string | null | undefined,
): ChoiceItemSize | null {
  if (templateId === null || templateId === undefined) return null;
  const template = buttons.find(
    (candidate) => candidate.definition.id === templateId,
  )?.definition;
  if (template === undefined) return null;
  return { width: template.width, height: template.height };
}

/**
 * Effective size of one option with the runtime's priority: node-wide
 * override, then the option template, then the node template, then the
 * documented built-in fallback.
 */
export function resolveChoiceOptionSize(
  option: ChoiceDefinition,
  presentation: ChoicePresentation | null | undefined,
  buttons: readonly ButtonFile[],
): ChoiceItemSize {
  return resolveChoiceItemSize({
    template:
      templateSize(buttons, option.template) ??
      templateSize(buttons, presentation?.template),
    button_width: presentation?.button_width ?? null,
    button_height: presentation?.button_height ?? null,
  });
}

/** Sizes every currently-defined option resolves to, in authoring order. */
export function resolveChoiceOptionSizes(
  node: ChoiceNode,
  buttons: readonly ButtonFile[],
): ChoiceItemSize[] {
  return node.choices.map((option) =>
    resolveChoiceOptionSize(option, node.presentation, buttons),
  );
}

/**
 * Presentation-less placement the runtime reports for this node.
 *
 * When a Rust preview is available its choices are already filtered and
 * ordered, so use those resolved dimensions instead of evaluating the
 * authored condition expressions (or reserving space for hidden options) in
 * React.  The local authored-size calculation remains the documented fallback
 * while no ready preview exists.
 */
export function legacyChoicePresentationAnchor(
  node: ChoiceNode,
  buttons: readonly ButtonFile[],
  direction: ChoiceFlowDirection = "vertical",
  gap: number = CHOICE_DEFAULT_GAP,
  previewPrompt: ChoicePrompt | null | undefined = null,
): { anchor_x: number; anchor_y: number } {
  const sizes =
    previewPrompt?.kind === "choice"
      ? previewPrompt.choices.map(({ width, height }) => ({ width, height }))
      : resolveChoiceOptionSizes(node, buttons);
  return legacyChoiceAnchor(direction, gap, sizes);
}

/**
 * Presentation object created when an author first enables it.
 *
 * The anchor is seeded from the resolved legacy-layout centre, so enabling
 * presentation does not move the buttons: the new anchor reproduces exactly
 * the shipped CSS panel placement the node had a moment earlier.  Every other
 * field keeps the runtime default.
 */
export function defaultChoicePresentation(
  node: ChoiceNode,
  buttons: readonly ButtonFile[],
  previewPrompt: ChoicePrompt | null | undefined = null,
): ChoicePresentation {
  const { anchor_x, anchor_y } = legacyChoicePresentationAnchor(node, buttons);
  // `ChoicePreview` reports a PromptSnapshot produced by Rust.  Its layout is
  // already filtered (and therefore includes the current conditions) and its
  // direction/gap are the runtime values.  Reusing it avoids evaluating
  // conditions in React and keeps the first opt-in anchored to what the player
  // actually saw.  If no snapshot is available, the documented legacy CSS
  // panel is vertical and its centre is the deterministic fallback above.
  if (previewPrompt?.kind === "choice") {
    return {
      template: null,
      anchor_x: roundAnchor(previewPrompt.layout.anchor_x),
      anchor_y: roundAnchor(previewPrompt.layout.anchor_y),
      direction: previewPrompt.layout.direction,
      gap: previewPrompt.layout.gap,
      button_width: null,
      button_height: null,
    };
  }
  return {
    template: null,
    anchor_x: roundAnchor(anchor_x),
    anchor_y: roundAnchor(anchor_y),
    direction: "vertical",
    gap: CHOICE_DEFAULT_GAP,
    button_width: null,
    button_height: null,
  };
}

/** Presentation defaults used when a node converts into a `choice` node. */
export function emptyChoicePresentation(): ChoicePresentation {
  return {
    template: null,
    anchor_x: CHOICE_DEFAULT_ANCHOR_X,
    anchor_y: CHOICE_DEFAULT_ANCHOR_Y,
    direction: "vertical",
    gap: CHOICE_DEFAULT_GAP,
    button_width: null,
    button_height: null,
  };
}

/**
 * Re-seed anchors onto the legacy placement while keeping every authored
 * template/size field.  Used by the inspector so an author can recover the
 * shipped position after experimenting without losing the skin choices.
 */
export function reseedChoicePresentationAnchor(
  node: ChoiceNode,
  buttons: readonly ButtonFile[],
  previewPrompt: ChoicePrompt | null | undefined = null,
): ChoicePresentation {
  const presentation = node.presentation ?? emptyChoicePresentation();
  const { anchor_x, anchor_y } = legacyChoicePresentationAnchor(
    node,
    buttons,
    presentation.direction,
    presentation.gap,
    previewPrompt,
  );
  return {
    ...presentation,
    anchor_x: roundAnchor(anchor_x),
    anchor_y: roundAnchor(anchor_y),
  };
}

/** Stable two-decimal anchor; a centre from integer sizes is at worst `.5`. */
function roundAnchor(value: number): number {
  return Math.round(value * 100) / 100;
}

/** GUI asset ids usable as a choice icon, in stable id order. */
export function choiceIconOptions(
  manifest: ContentManifest,
): { id: string; kind: string }[] {
  return Object.entries(manifest.assets)
    .filter(([, asset]) => asset.kind === "gui")
    .map(([id, asset]) => ({ id, kind: asset.kind }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
