import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactElement,
} from "react";

import {
  resolveImageAsset,
  type AnimationMap,
} from "@vectspace/presentation-core/image-animation";
import type {
  AssetUrlMap,
  ButtonSnapshot,
  ChoiceDiagnostic,
  ChoicePrompt,
  ChoiceSnapshot,
} from "@vectspace/presentation-core/types";

import { AnimatedImage } from "../AnimatedImage";
import { TemplateButton } from "../button/TemplateButton";
import { MarkupLabel, markupAccessibleLabel } from "../markup/MarkupLabel";
import "./choice.css";

export interface ChoiceLayerProps {
  /** Canonical prompt snapshot; every rect is design pixels in 1920x1080. */
  prompt: ChoicePrompt;
  assets: AssetUrlMap;
  /** Frame lists for animated template/icon artwork. */
  animations?: AnimationMap;
  /** Blocks activation for the whole group (open menu, runtime lock). */
  disabled?: boolean;
  paused?: boolean;
  playbackRate?: number;
  /** Container class; the editor preview passes its own scoped class. */
  className?: string;
  /** One-shot report of a runtime presentation diagnostic. */
  onDiagnostic?(diagnostic: ChoiceDiagnostic): void;
  onChoose(choiceId: string): void;
}

/**
 * The shared, template-driven choice surface.
 *
 * It renders exactly what the runtime resolved — item rects, per-item template
 * skins and `gui` icons — and nothing else.  A host that needs a different
 * placement scales this container; it never re-flows the items, so the game
 * and the editor preview are pixel-identical by construction.
 *
 * Focus rules:
 *
 * - a harmless re-render of the same prompt keeps DOM identity, so keyboard
 *   focus stays on the item the player was on,
 * - when the prompt id changes, or the focused item disappears from the new
 *   option set, focus is released instead of pointing at stale content.
 */
export function ChoiceLayer({
  prompt,
  assets,
  animations = {},
  disabled = false,
  paused = false,
  playbackRate = 1,
  className,
  onDiagnostic,
  onChoose,
}: ChoiceLayerProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const promptIdRef = useRef(prompt.prompt_id);
  const choiceIds = prompt.choices.map((choice) => choice.id);
  const choiceKey = choiceIds.join("\u0000");

  // A prompt change must never leave the keyboard on an option that no longer
  // exists.  Hosts also key by prompt id, but a host that reuses the mounted
  // layer must still get the safe reset.
  useEffect(() => {
    if (promptIdRef.current === prompt.prompt_id) return;
    promptIdRef.current = prompt.prompt_id;
    releaseFocus(rootRef.current);
  }, [prompt.prompt_id]);

  useEffect(() => {
    const root = rootRef.current;
    const active = document.activeElement;
    if (root === null || !(active instanceof HTMLElement)) return;
    if (!root.contains(active)) return;
    const focusedId = active.getAttribute("data-choice-id");
    if (focusedId !== null && !choiceKey.split("\u0000").includes(focusedId)) {
      active.blur();
    }
  }, [choiceKey]);

  const diagnostics = prompt.diagnostics;
  const onDiagnosticRef = useRef(onDiagnostic);
  useEffect(() => {
    onDiagnosticRef.current = onDiagnostic;
  }, [onDiagnostic]);
  const reportedDiagnostics = useRef(new Set<string>());
  useEffect(() => {
    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.code}:${diagnostic.node_id}:${diagnostic.choice_id ?? ""}:${diagnostic.message}`;
      if (reportedDiagnostics.current.has(key)) continue;
      reportedDiagnostics.current.add(key);
      onDiagnosticRef.current?.(diagnostic);
    }
  }, [diagnostics]);

  return (
    <div
      aria-label="选项"
      className={className ?? "choice-layer"}
      ref={rootRef}
      role="group"
    >
      {prompt.choices.map((choice) => (
        <ChoiceItem
          animations={animations}
          assets={assets}
          choice={choice}
          disabled={disabled}
          key={choice.id}
          onChoose={onChoose}
          paused={paused}
          playbackRate={playbackRate}
          sessionKey={prompt.prompt_id}
        />
      ))}
    </div>
  );
}

function ChoiceItem({
  choice,
  assets,
  animations,
  disabled,
  paused,
  playbackRate,
  sessionKey,
  onChoose,
}: {
  choice: ChoiceSnapshot;
  assets: AssetUrlMap;
  animations: AnimationMap;
  disabled: boolean;
  paused: boolean;
  playbackRate: number;
  sessionKey: string;
  onChoose(choiceId: string): void;
}): ReactElement {
  const rectStyle: CSSProperties = {
    left: choice.x,
    top: choice.y,
    width: choice.width,
    height: choice.height,
  };
  const icon =
    choice.icon === null || choice.icon === undefined ? null : (
      <AnimatedImage
        alt=""
        className="choice-button-icon"
        paused={paused}
        source={resolveImageAsset(choice.icon, assets, animations)}
      />
    );
  const button =
    choice.template.kind === "button"
      ? choice.template.button
      : fallbackButtonSnapshot(choice);
  // The KaTeX/markup body is hidden from the accessibility tree by
  // `MarkupLabel`; the native button therefore gets a plain-text name derived
  // by the shared markup parser instead of raw `$…$` delimiters or a name of
  // aria-hidden KaTeX nodes.
  const accessibleLabel = markupAccessibleLabel(choice.label) || choice.id;
  return (
    <TemplateButton
      activation="native"
      animations={animations}
      ariaLabel={accessibleLabel}
      assets={assets}
      button={button}
      className="choice-button"
      dataChoiceId={choice.id}
      disabled={disabled}
      fallbackClassName="choice-button-fallback"
      onActivate={() => onChoose(choice.id)}
      paused={paused}
      playbackRate={playbackRate}
      sessionKey={`${sessionKey}:${choice.id}`}
      style={rectStyle}
    >
      {icon}
      <MarkupLabel className="choice-button-label" source={choice.label} />
    </TemplateButton>
  );
}

/**
 * Skin used when no reusable template resolved (or its artwork is missing).
 *
 * The synthetic snapshot keeps every non-visual concern — disabled state,
 * hover/press/cancel, native keyboard activation — on the same code path as a
 * real template, while the `choice-button-fallback` class supplies the
 * documented built-in CSS skin.  Its `id` is the choice id so the button keeps
 * a stable `data-choice-id`.
 */
function fallbackButtonSnapshot(choice: ChoiceSnapshot): ButtonSnapshot {
  return {
    id: choice.id,
    template: "choice.fallback",
    asset_mode: "separate",
    fit: "stretch",
    normal: null,
    hover: null,
    pressed: null,
    animations: {},
    x: choice.x,
    y: choice.y,
    width: choice.width,
    height: choice.height,
    rotation_deg: 0,
    scale_x: 1,
    scale_y: 1,
    opacity: 1,
    z: 0,
    visible: true,
    enabled: choice.enabled,
    action: { sets: [], next: null },
  };
}

function releaseFocus(root: HTMLDivElement | null): void {
  const active = document.activeElement;
  if (root === null || !(active instanceof HTMLElement)) return;
  if (root.contains(active)) active.blur();
}
