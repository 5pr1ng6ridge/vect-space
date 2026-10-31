import type { ReactElement, RefObject } from "react";

import {
  DialogueBox,
  LongTextPanel,
  type DialogueBoxHandle,
  type LongTextPanelHandle,
} from "@vectspace/presentation-react/gameplay";
import { ChoiceLayer } from "@vectspace/presentation-react/choice";
import {
  resolveImageAsset,
  type AnimationMap,
} from "@vectspace/presentation-core/image-animation";
import type { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import type {
  AssetUrlMap,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";

import { ProofPromptLayer } from "./ProofPromptLayer";
import type {
  ProofCheckResult,
  ProofGraph,
} from "@vectspace/presentation-core/proof";
import type { PromptView } from "../engine/promptView";
import type { TextRevealState } from "../engine/useTextReveal";

interface PromptLayersProps {
  update: RuntimeUpdate;
  view: PromptView;
  assets: AssetUrlMap;
  animations: AnimationMap;
  uiMotionHost: UiMotionHost;
  /** Input is locked while a command or a presentation gate is pending. */
  disabled: boolean;
  /** Reveal and choice animation stop while a panel or hidden page covers them. */
  suspended: boolean;
  fastForward: boolean;
  reveal: TextRevealState;
  fontReady: boolean;
  fontKey: string;
  designScale: number;
  dialogueRef: RefObject<DialogueBoxHandle | null>;
  longTextRef: RefObject<LongTextPanelHandle | null>;
  onTypingChange(typing: boolean, cps: number): void;
  onRevealComplete(instanceKey: string): void;
  onProofSubmit?(
    graph: ProofGraph,
  ): Promise<{ accepted: boolean; check: ProofCheckResult }>;
  onProofAbandon?(): void;
  onChoose(choiceId: string): void;
  onDiagnostic(message: string): void;
}

/** Dialogue box, long-text panel and choice layer shared by both windows. */
export function PromptLayers({
  update,
  view,
  assets,
  animations,
  uiMotionHost,
  disabled,
  suspended,
  fastForward,
  reveal,
  fontReady,
  fontKey,
  designScale,
  dialogueRef,
  longTextRef,
  onTypingChange,
  onRevealComplete,
  onProofSubmit,
  onProofAbandon,
  onChoose,
  onDiagnostic,
}: PromptLayersProps): ReactElement {
  const { dialogue, longText, choice, renderedDialoguePage, longTextPage } =
    view;
  return (
    <>
      {renderedDialoguePage !== null && (
        <DialogueBox
          defaultCps={reveal.defaultCps}
          dialogueBoxSource={
            resolveImageAsset("gui.dialogue_box", assets, animations) ?? null
          }
          disabled={disabled}
          initialCps={reveal.cps}
          key={reveal.instanceKey ?? `retained:${update.update_id}`}
          motionHost={uiMotionHost}
          nameBoxSource={
            resolveImageAsset("gui.name_box", assets, animations) ?? null
          }
          onTypingChange={onTypingChange}
          onRevealComplete={onRevealComplete}
          page={renderedDialoguePage}
          prompt={dialogue}
          revealAnimation={reveal.animation}
          fontReady={fontReady}
          measurementScale={designScale}
          ref={dialogueRef}
          revealImmediately={dialogue === null || !reveal.hasRevealCue}
          sessionKey={
            dialogue === null
              ? `retained:${renderedDialoguePage.page_id}`
              : (reveal.instanceKey ?? update.update_id)
          }
          suspended={suspended}
          visible={update.snapshot.world.dialogue_ui_visible}
        />
      )}

      {longTextPage !== null && (
        <LongTextPanel
          defaultCps={reveal.defaultCps}
          disabled={disabled || longText === null}
          fastForward={fastForward}
          initialCps={reveal.cps}
          key={longTextPage.document_id}
          onRevealComplete={onRevealComplete}
          onTypingChange={onTypingChange}
          page={longTextPage}
          paperSource={
            longTextPage.paper === null || longTextPage.paper === undefined
              ? undefined
              : (resolveImageAsset(longTextPage.paper, assets, animations) ??
                null)
          }
          prompt={longText}
          revealAnimation={reveal.animation}
          designScale={designScale}
          fontReady={fontReady}
          fontKey={fontKey}
          ref={longTextRef}
          revealImmediately={!reveal.hasRevealCue}
          sessionKey={
            longText === null
              ? `retained:${longTextPage.document_id}:${longTextPage.active_step_index}`
              : (reveal.instanceKey ?? update.update_id)
          }
          suspended={suspended}
          visible={longTextPage.visible !== false}
        />
      )}

      {view.proof !== null &&
        onProofSubmit &&
        onProofAbandon &&
        update.session_id !== undefined && (
          <ProofPromptLayer
            key={view.proof.prompt_id}
            prompt={view.proof}
            sessionId={update.session_id}
            onSubmit={onProofSubmit}
            onAbandon={onProofAbandon}
            onDiagnostic={onDiagnostic}
          />
        )}
      {choice !== null && (
        // Keep this component mounted across same-prompt runtime updates.
        // ChoiceLayer owns the stable prompt-id reset; update_id is a volatile
        // revision and must not restart focus or artwork loops.
        <ChoiceLayer
          animations={animations}
          assets={assets}
          disabled={disabled}
          onChoose={onChoose}
          // A non-fatal presentation problem (missing template/icon, invalid
          // anchor) is surfaced once instead of locking the prompt; the
          // resolved fallback skin stays playable.
          onDiagnostic={(diagnostic) => onDiagnostic(diagnostic.message)}
          paused={suspended}
          prompt={choice}
        />
      )}
    </>
  );
}
