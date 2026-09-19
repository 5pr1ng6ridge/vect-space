import { listen } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import "katex/dist/katex.min.css";
import "./App.css";

import { ButtonLayer } from "./components/ButtonLayer";
import { DialogueBox, type DialogueBoxHandle } from "./components/DialogueBox";
import {
  LongTextPanel,
  type LongTextPanelHandle,
} from "./components/LongTextPanel";
import { SceneCanvas, type SceneCanvasHandle } from "./components/SceneCanvas";
import { ChoiceLayer } from "@vectspace/presentation-react/choice";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { resolveImageAsset } from "@vectspace/presentation-core/image-animation";
import { BoundedLedger } from "@vectspace/presentation-core/ledger";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import { autoReadingDelay } from "@vectspace/text";

import {
  engineApi,
  resolvedAssetsToAnimations,
  resolvedAssetsToUrls,
} from "./engine/api";
import { CommandError } from "../shared/commandError";
import { requireSessionId } from "./engine/session";
import { canFastForwardPrompt } from "./engine/playback";
import type {
  AdvanceSource,
  AssetUrlMap,
  DialoguePrompt,
  LongTextPrompt,
  PresentationCue,
  RuntimeUpdate,
  Settings,
  TextRevealAnimation,
} from "./engine/types";
import { useViewportMetrics } from "./viewport/viewport";
import type { WireU64 } from "../shared/generated/WireU64";

/**
 * The single secondary game window's shell.
 *
 * It deliberately reuses the gameplay presentation components (scene surface,
 * button layer, dialogue box, long-text panel and choice layer) but none of the
 * main window's shell: there is no title screen, chapter map, save/load panel,
 * settings panel, history panel or toolbar. The host also refuses those
 * commands from this window, so hiding the UI is a convenience rather than the
 * security boundary.
 *
 * Its session identity is independent of the main window: the host issues a
 * fresh secondary token on every create/replace/load, and a response whose
 * token is not the one this instance bootstrapped with is dropped instead of
 * applied.
 */

/**
 * The host emits this after it re-points the secondary runtime in this same
 * native window (a repeated `open_window`). A missed event is harmless because
 * the window also bootstraps itself on mount.
 */
const SECONDARY_SESSION_EVENT = "vectspace://secondary-session";

const DEFAULT_SETTINGS: Settings = {
  master_volume: 1,
  bgm_volume: 0.7,
  sfx_volume: 0.8,
  video_volume: 1,
  ambience_volume: 0.8,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "read_only",
};

type Status = "booting" | "playing" | "failed";

interface LockedTextSettings {
  instanceKey: string;
  defaultCps: number;
  initialCps: number;
  animation: TextRevealAnimation;
}

export default function SecondaryWindow(): ReactElement {
  const { metrics: viewportMetrics, style: viewportStyle } =
    useViewportMetrics();
  const sceneRef = useRef<SceneCanvasHandle>(null);
  const dialogueRef = useRef<DialogueBoxHandle>(null);
  const longTextRef = useRef<LongTextPanelHandle>(null);
  const uiMotionHost = useMemo(() => new UiMotionHost(), []);
  const acknowledgedUpdates = useRef(new BoundedLedger<string>(128));
  const busyRef = useRef(false);
  // Bumped on every bootstrap/replacement. A response from an older generation
  // must never be applied to the newer session.
  const generationRef = useRef(0);
  const sessionRef = useRef<WireU64>("0");

  const [status, setStatus] = useState<Status>("booting");
  const [update, setUpdate] = useState<RuntimeUpdate | null>(null);
  const [assets, setAssets] = useState<AssetUrlMap>({});
  const [animations, setAnimations] = useState<AnimationMap>({});
  const [defaultFontId, setDefaultFontId] = useState<string | null>(null);
  const [loadedFontUrl, setLoadedFontUrl] = useState<string | null>(null);
  const [fontLoadErrorUrl, setFontLoadErrorUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typingSfxActive, setTypingSfxActive] = useState(false);
  const [typingSfxCps, setTypingSfxCps] = useState(
    DEFAULT_SETTINGS.text_speed_cps,
  );
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [pageHidden, setPageHidden] = useState(document.hidden);
  const [completedPromptKey, setCompletedPromptKey] = useState<string | null>(
    null,
  );
  const [lockedTextSettings, setLockedTextSettings] =
    useState<LockedTextSettings | null>(null);

  const applyUpdate = useCallback((next: RuntimeUpdate): void => {
    sessionRef.current = requireSessionId(next.session_id);
    setUpdate(next);
  }, []);

  /**
   * Fetch the authoritative update for this window's current host session.
   * Called on mount and whenever the host reports that the same window now
   * carries a different secondary scene.
   */
  const bootstrap = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    // A replacement invalidates every in-flight command and every piece of
    // per-generation presentation state. Resetting `busy` here - not only in the
    // command's own `finally` - is what keeps an old command from wedging the
    // new session: the old command refuses to touch state that no longer belongs
    // to its generation, so nothing else would ever clear it.
    busyRef.current = false;
    setBusy(false);
    acknowledgedUpdates.current.clear();
    setUpdate(null);
    setStatus("booting");
    setError(null);
    setCompletedPromptKey(null);
    setLockedTextSettings(null);
    sceneRef.current?.cancelCurrentPresentation();
    try {
      const payload = await engineApi.secondaryBootstrap();
      const resolved = await engineApi.resolveAssets(payload.asset_ids);
      if (generation !== generationRef.current) return;
      setAssets(resolvedAssetsToUrls(resolved));
      setAnimations(resolvedAssetsToAnimations(resolved));
      setDefaultFontId(payload.default_font ?? null);
      sessionRef.current = requireSessionId(payload.update.session_id);
      setUpdate(payload.update);
      setStatus("playing");
      await sceneRef.current?.unlockAudio();
    } catch (reason: unknown) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(reason));
      setStatus("failed");
    }
  }, []);

  const recoverReplacedSession = useCallback((): void => {
    void bootstrap();
  }, [bootstrap]);

  /**
   * The replacement listener is registered *before* the first bootstrap so a
   * repeated `open_window` that re-points this window while it is still starting
   * up cannot be missed. The initial bootstrap only runs once the subscription is
   * in place (or has failed, which the stale-session recovery below still
   * covers).
   */
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    const start = async (): Promise<void> => {
      try {
        const stop = await listen(SECONDARY_SESSION_EVENT, () => {
          void bootstrap();
        });
        if (!active) {
          stop();
          return;
        }
        unlisten = stop;
      } catch (reason: unknown) {
        // Losing the replacement event only costs an immediate refresh: a
        // replaced session is still adopted through the stale-session recovery.
        console.error("副窗口会话事件订阅失败", reason);
      }
      if (!active) return;
      // Bootstrap runs after a macrotask boundary so the mount effect never sets
      // state synchronously during render commit (which React warns about).
      await bootstrap();
    };
    const frame = window.setTimeout(() => {
      void start();
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(frame);
      unlisten?.();
    };
  }, [bootstrap]);

  useEffect(() => {
    const fontUrl = defaultFontId === null ? undefined : assets[defaultFontId];
    if (fontUrl === undefined) return;
    let active = true;
    const face = new FontFace("VECT Pixel", `url("${fontUrl}")`, {
      display: "swap",
    });
    document.fonts.add(face);
    void face
      .load()
      .then(async () => {
        await document.fonts.ready;
        if (active) setLoadedFontUrl(fontUrl);
      })
      .catch((reason: unknown) => {
        if (active) {
          setFontLoadErrorUrl(fontUrl);
          setError(`中文字体加载失败，已使用系统字体：${errorMessage(reason)}`);
        }
      });
    return () => {
      active = false;
      document.fonts.delete(face);
    };
  }, [assets, defaultFontId]);

  const fontUrl = defaultFontId === null ? undefined : assets[defaultFontId];
  const fontReady =
    fontUrl === undefined ||
    loadedFontUrl === fontUrl ||
    fontLoadErrorUrl === fontUrl;

  const runCommand = useCallback(
    async (command: () => Promise<RuntimeUpdate>): Promise<boolean> => {
      if (busyRef.current) return false;
      const generation = generationRef.current;
      const expectedSessionId = sessionRef.current;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const next = await command();
        if (generation !== generationRef.current) return false;
        const returned = requireSessionId(next.session_id);
        if (returned !== expectedSessionId) {
          // The host re-pointed this window while the command was in flight, so
          // this response belongs to another instance. Adopt the new session
          // instead of applying a stale update.
          recoverReplacedSession();
          return false;
        }
        applyUpdate(next);
        return true;
      } catch (reason: unknown) {
        if (generation === generationRef.current) {
          if (isStaleSessionError(reason)) {
            // The host session changed under this command. Re-bootstrapping is
            // the deterministic recovery for every replacement race, including
            // a replacement event that was emitted before this instance could
            // listen for it.
            recoverReplacedSession();
          } else {
            setError(errorMessage(reason));
          }
        }
        return false;
      } finally {
        if (generation === generationRef.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [applyUpdate, recoverReplacedSession],
  );

  const handlePresentationSettled = useCallback(
    (
      settled: RuntimeUpdate,
      outcome: "completed" | "skipped" | "failed",
    ): void => {
      if (
        settled.session_id === undefined ||
        settled.session_id !== sessionRef.current ||
        busyRef.current ||
        !settled.requires_ack
      ) {
        return;
      }
      if (
        !acknowledgedUpdates.current.consume(
          `${settled.session_id}:${settled.update_id}`,
        )
      ) {
        return;
      }
      void runCommand(() =>
        engineApi.secondaryPresentationComplete(
          settled.update_id,
          outcome,
          settled.session_id as WireU64,
        ),
      );
    },
    [runCommand],
  );

  const advance = useCallback(
    (source: AdvanceSource): void => {
      const snapshot = update?.snapshot;
      if (
        snapshot === undefined ||
        (snapshot.prompt.kind !== "dialogue" &&
          snapshot.prompt.kind !== "long_text")
      ) {
        return;
      }
      void runCommand(() =>
        engineApi.secondaryAdvance(
          snapshot.revision,
          source,
          sessionRef.current,
        ),
      );
    },
    [runCommand, update],
  );

  const choose = useCallback(
    (choiceId: string): void => {
      const snapshot = update?.snapshot;
      if (snapshot === undefined || snapshot.prompt.kind !== "choice") return;
      void runCommand(() =>
        engineApi.secondaryChoose(
          choiceId,
          snapshot.revision,
          sessionRef.current,
        ),
      );
    },
    [runCommand, update],
  );

  const clickButton = useCallback(
    (instanceId: string): void => {
      const snapshot = update?.snapshot;
      if (
        snapshot === undefined ||
        status !== "playing" ||
        busyRef.current ||
        update?.requires_ack
      ) {
        return;
      }
      void runCommand(() =>
        engineApi.secondaryClickButton(
          instanceId,
          snapshot.revision,
          sessionRef.current,
        ),
      );
    },
    [runCommand, status, update],
  );

  const dialogue =
    update?.snapshot.prompt.kind === "dialogue" ? update.snapshot.prompt : null;
  const longText =
    update?.snapshot.prompt.kind === "long_text"
      ? update.snapshot.prompt
      : null;
  const textPrompt: DialoguePrompt | LongTextPrompt | null =
    dialogue ?? longText;
  const dialoguePage =
    update?.snapshot.dialogue_page ??
    (dialogue === null
      ? null
      : {
          page_id: dialogue.prompt_id,
          speaker: dialogue.speaker,
          speaker_id: dialogue.speaker_id ?? null,
          name_color: dialogue.name_color ?? null,
          text_color: dialogue.text_color ?? null,
          segments: [dialogue.text],
        });
  const hasUiMotionCue =
    update?.cues.some(
      (cue) =>
        cue.type === "dialogue_ui_transition" || cue.type === "ui_motion",
    ) ?? false;
  const renderedDialoguePage =
    longText === null
      ? (dialoguePage ??
        (hasUiMotionCue
          ? {
              page_id: "ui_motion_preview",
              speaker: null,
              speaker_id: null,
              name_color: null,
              text_color: null,
              segments: [""],
            }
          : null))
      : null;
  const longTextPage = update?.snapshot.long_text_page ?? null;
  const choice =
    update?.snapshot.prompt.kind === "choice" ? update.snapshot.prompt : null;
  const runtimeLocked = update?.requires_ack ?? false;
  const timelineCue = update?.cues.find(
    (cue): cue is Extract<PresentationCue, { type: "timeline" }> =>
      cue.type === "timeline",
  );
  const runtimeTimelineCue = update?.cues.find(
    (cue): cue is Extract<PresentationCue, { type: "timeline" }> =>
      cue.type === "timeline" && cue.gate === "runtime",
  );
  const playback = update?.snapshot.playback ?? {
    auto: "normal" as const,
    ctrl_fast_forward: "allow" as const,
  };
  const forcedAuto = playback.auto === "forced";
  const fastForwardRequested =
    ctrlHeld &&
    !forcedAuto &&
    playback.ctrl_fast_forward === "allow" &&
    DEFAULT_SETTINGS.skip_mode !== "disabled";
  const fastForwardDialogueAllowed =
    textPrompt !== null &&
    (DEFAULT_SETTINGS.skip_mode === "all" ||
      (DEFAULT_SETTINGS.skip_mode === "read_only" && textPrompt.is_read));
  const fastForwardActive =
    status === "playing" &&
    fastForwardRequested &&
    update !== null &&
    canFastForwardPrompt(
      playback,
      DEFAULT_SETTINGS.skip_mode,
      update.snapshot.prompt,
    ) &&
    (runtimeTimelineCue === undefined ||
      DEFAULT_SETTINGS.skip_mode === "all" ||
      (DEFAULT_SETTINGS.skip_mode === "read_only" &&
        runtimeTimelineCue.is_seen));

  const textCueCps = useMemo(
    () => textRevealSpeed(update, textPrompt),
    [textPrompt, update],
  );
  const hasTextRevealCue =
    update?.cues.some(
      (cue) =>
        (cue.type === "dialogue_reveal" || cue.type === "long_text_reveal") &&
        cue.prompt_id === textPrompt?.prompt_id,
    ) ?? false;
  const cueRevealAnimation = textRevealAnimation(update, textPrompt);
  const textInstanceKey =
    textPrompt === null
      ? null
      : `${update?.update_id ?? "none"}:${textPrompt.prompt_id}`;
  const currentTextSettings = useMemo<LockedTextSettings | null>(() => {
    if (textPrompt === null) return null;
    return {
      instanceKey: textInstanceKey ?? "none",
      defaultCps: DEFAULT_SETTINGS.text_speed_cps,
      initialCps: textCueCps ?? DEFAULT_SETTINGS.text_speed_cps,
      animation: cueRevealAnimation ?? DEFAULT_SETTINGS.text_reveal_animation,
    };
  }, [cueRevealAnimation, textCueCps, textInstanceKey, textPrompt]);
  useEffect(() => {
    if (currentTextSettings === null) {
      const frame = requestAnimationFrame(() => setLockedTextSettings(null));
      return () => cancelAnimationFrame(frame);
    }
    const frame = requestAnimationFrame(() => {
      setLockedTextSettings((previous) =>
        previous?.instanceKey === currentTextSettings.instanceKey
          ? previous
          : currentTextSettings,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [currentTextSettings]);
  const effectiveTextSettings =
    lockedTextSettings?.instanceKey === currentTextSettings?.instanceKey
      ? lockedTextSettings
      : currentTextSettings;
  const revealCps =
    effectiveTextSettings?.initialCps ?? DEFAULT_SETTINGS.text_speed_cps;
  const revealDefaultCps =
    effectiveTextSettings?.defaultCps ?? DEFAULT_SETTINGS.text_speed_cps;
  const revealAnimation =
    effectiveTextSettings?.animation ?? DEFAULT_SETTINGS.text_reveal_animation;

  const handleTypingChange = useCallback(
    (typing: boolean, cps: number): void => {
      setTypingSfxActive(typing);
      setTypingSfxCps(cps);
    },
    [],
  );
  const handleRevealComplete = useCallback((instanceKey: string): void => {
    setCompletedPromptKey(instanceKey);
  }, []);

  const handlePlayerAdvance = useCallback((): void => {
    if (status !== "playing" || busyRef.current) return;
    if (
      !runtimeLocked &&
      (textPrompt === null ||
        (longText === null && !update?.snapshot.world.dialogue_ui_visible))
    ) {
      return;
    }
    void sceneRef.current?.unlockAudio();
    if (forcedAuto) return;
    if (runtimeLocked) {
      sceneRef.current?.skipCurrentPresentation();
      return;
    }
    if (textPrompt === null) return;
    const textHandle =
      longText === null ? dialogueRef.current : longTextRef.current;
    if (!textHandle?.isComplete()) {
      textHandle?.complete();
      return;
    }
    advance("manual");
  }, [
    advance,
    forcedAuto,
    longText,
    runtimeLocked,
    status,
    textPrompt,
    update,
  ]);

  useEffect(() => {
    let timer = 0;
    if (status !== "playing" || busy || runtimeLocked) return;
    if (textPrompt === null || completedPromptKey !== textInstanceKey) return;
    if (forcedAuto) {
      timer = window.setTimeout(
        () => advance("forced_auto"),
        autoReadingDelay(textPrompt.text),
      );
    } else if (fastForwardRequested && fastForwardDialogueAllowed) {
      timer = window.setTimeout(() => advance("fast_forward"), 50);
    }
    return () => window.clearTimeout(timer);
  }, [
    advance,
    busy,
    completedPromptKey,
    fastForwardDialogueAllowed,
    fastForwardRequested,
    forcedAuto,
    runtimeLocked,
    status,
    textInstanceKey,
    textPrompt,
  ]);

  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      if (
        event.button === 0 &&
        !event.defaultPrevented &&
        !isInteractiveTarget(event.target)
      ) {
        handlePlayerAdvance();
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code === "ControlLeft" || event.code === "ControlRight") {
        setCtrlHeld(true);
        return;
      }
      if (
        event.key === "Enter" &&
        !event.repeat &&
        !event.defaultPrevented &&
        !isInteractiveTarget(event.target)
      ) {
        event.preventDefault();
        handlePlayerAdvance();
      }
    };
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== "ControlLeft" && event.code !== "ControlRight") return;
      setCtrlHeld(false);
    };
    const clearControlKeys = (): void => setCtrlHeld(false);
    const handleVisibility = (): void => {
      setPageHidden(document.hidden);
      if (document.hidden) clearControlKeys();
    };
    window.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearControlKeys);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearControlKeys);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [handlePlayerAdvance]);

  return (
    <main className="app-shell" data-window-role="secondary">
      <section className="game-viewport" style={viewportStyle}>
        <SceneCanvas
          animations={animations}
          assets={assets}
          onDiagnostic={setError}
          onSettled={handlePresentationSettled}
          paused={status !== "playing" || pageHidden}
          playbackRate={fastForwardActive ? 8 : 1}
          ref={sceneRef}
          settings={DEFAULT_SETTINGS}
          suppressOneShots={fastForwardActive}
          typingSfxActive={typingSfxActive && !fastForwardActive}
          typingSfxCps={typingSfxCps}
          update={update}
          uiMotionHost={uiMotionHost}
          visible={status === "playing"}
        />

        {status === "playing" && update !== null && (
          <ButtonLayer
            animations={animations}
            assets={assets}
            disabled={busy || runtimeLocked}
            onClick={clickButton}
            paused={status !== "playing" || pageHidden}
            playbackRate={fastForwardActive ? 8 : 1}
            snapshot={update.snapshot}
            timeline={timelineCue ?? null}
          />
        )}

        {status === "booting" && (
          <div className="boot-screen">
            <div className="loader" />
            <p>正在连接副窗口运行时…</p>
          </div>
        )}

        {status === "playing" && update !== null && (
          <>
            {renderedDialoguePage !== null && (
              <DialogueBox
                defaultCps={revealDefaultCps}
                dialogueBoxSource={
                  resolveImageAsset("gui.dialogue_box", assets, animations) ??
                  null
                }
                disabled={busy || runtimeLocked}
                initialCps={revealCps}
                key={`${update.update_id}:${dialogue?.prompt_id ?? `retained:${update.snapshot.revision}`}`}
                motionHost={uiMotionHost}
                nameBoxSource={
                  resolveImageAsset("gui.name_box", assets, animations) ?? null
                }
                onTypingChange={handleTypingChange}
                onRevealComplete={handleRevealComplete}
                page={renderedDialoguePage}
                prompt={dialogue}
                revealAnimation={revealAnimation}
                fontReady={fontReady}
                measurementScale={viewportMetrics.scale}
                ref={dialogueRef}
                revealImmediately={dialogue === null || !hasTextRevealCue}
                sessionKey={`${update.update_id}:${dialogue?.prompt_id ?? `retained:${renderedDialoguePage.page_id}`}`}
                suspended={pageHidden}
                visible={update.snapshot.world.dialogue_ui_visible}
              />
            )}

            {longTextPage !== null && (
              <LongTextPanel
                defaultCps={revealDefaultCps}
                disabled={busy || runtimeLocked || longText === null}
                fastForward={fastForwardActive}
                initialCps={revealCps}
                key={longTextPage.document_id}
                onRevealComplete={handleRevealComplete}
                onTypingChange={handleTypingChange}
                page={longTextPage}
                paperSource={
                  longTextPage.paper === null ||
                  longTextPage.paper === undefined
                    ? undefined
                    : (resolveImageAsset(
                        longTextPage.paper,
                        assets,
                        animations,
                      ) ?? null)
                }
                prompt={longText}
                revealAnimation={revealAnimation}
                designScale={viewportMetrics.scale}
                fontReady={fontReady}
                fontKey={defaultFontId ?? "system"}
                ref={longTextRef}
                revealImmediately={!hasTextRevealCue}
                sessionKey={`${update.update_id}:${longText?.prompt_id ?? `retained:${longTextPage.active_step_index}`}`}
                suspended={pageHidden}
                visible={longTextPage.visible !== false}
              />
            )}

            {choice !== null && (
              <ChoiceLayer
                animations={animations}
                assets={assets}
                disabled={busy || runtimeLocked}
                onChoose={choose}
                onDiagnostic={(diagnostic) => setError(diagnostic.message)}
                paused={pageHidden}
                prompt={choice}
              />
            )}

            {update.snapshot.prompt.kind === "end" && (
              <div className="end-card">
                <p>副窗口场景结束</p>
                {/* No action: the main window owns the secondary's lifecycle. */}
              </div>
            )}

            {runtimeLocked && <div className="runtime-lock">表现同步中…</div>}
          </>
        )}

        {status === "failed" && (
          <div className="title-screen">
            <div className="title-card">
              <h1>副窗口不可用</h1>
              <p>{error ?? "副窗口会话已结束。"}</p>
              <div className="title-actions">
                <button onClick={() => void bootstrap()} type="button">
                  重试
                </button>
              </div>
            </div>
          </div>
        )}

        {error !== null && status !== "failed" && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} type="button">
              关闭
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function textRevealSpeed(
  update: RuntimeUpdate | null,
  prompt: DialoguePrompt | LongTextPrompt | null,
): number | null | undefined {
  if (update === null || prompt === null) return undefined;
  const cue = update.cues.find(
    (candidate) =>
      (candidate.type === "dialogue_reveal" ||
        candidate.type === "long_text_reveal") &&
      candidate.prompt_id === prompt.prompt_id,
  );
  return cue?.type === "dialogue_reveal" || cue?.type === "long_text_reveal"
    ? cue.speed_cps
    : undefined;
}

function textRevealAnimation(
  update: RuntimeUpdate | null,
  prompt: DialoguePrompt | LongTextPrompt | null,
): TextRevealAnimation | null {
  if (update === null || prompt === null) return null;
  const cue = update.cues.find(
    (candidate) =>
      (candidate.type === "dialogue_reveal" ||
        candidate.type === "long_text_reveal") &&
      candidate.prompt_id === prompt.prompt_id,
  );
  return cue?.type === "dialogue_reveal" || cue?.type === "long_text_reveal"
    ? (cue.reveal_animation ?? null)
    : null;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * True when the host rejected a request because this window's session was
 * re-pointed. The host uses this code for every stale token, so it is the one
 * signal that must trigger a re-bootstrap rather than a failure screen.
 */
function isStaleSessionError(reason: unknown): boolean {
  return reason instanceof CommandError && reason.code === "stale_session";
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, input, select, textarea, a, label, [contenteditable='true'], [data-block-story-advance]",
    ) !== null
  );
}
