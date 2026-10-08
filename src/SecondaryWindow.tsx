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

import {
  ButtonLayer,
  SceneCanvas,
  type DialogueBoxHandle,
  type LongTextPanelHandle,
  type SceneCanvasHandle,
} from "@vectspace/presentation-react/gameplay";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import {
  resolveTextBlocks,
  type TextBlockMap,
} from "@vectspace/presentation-core/text-block";
import type { ParticleMap } from "@vectspace/presentation-core/particles";
import { BoundedLedger } from "@vectspace/presentation-core/ledger";
import {
  activeTimerIds,
  advanceBlockMessages,
  isAdvanceBlocked,
} from "@vectspace/presentation-core/live-update";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import { requireSessionId } from "@vectspace/presentation-core/session-transition";
import type {
  AdvanceSource,
  AssetUrlMap,
  RuntimeUpdate,
  Settings,
} from "@vectspace/presentation-core/types";
import { autoReadingDelay } from "@vectspace/text";

import { CommandError, errorMessage } from "../shared/commandError";
import type { WireU64 } from "../shared/generated/WireU64";
import { AdvanceBlockNotice } from "./components/AdvanceBlockNotice";
import { PromptLayers } from "./components/PromptLayers";
import {
  engineApi,
  resolvedAssetsToAnimations,
  resolvedAssetsToUrls,
} from "./engine/api";
import { fastForwardState, isInteractiveTarget } from "./engine/playback";
import { describePrompt } from "./engine/promptView";
import { RuntimeFeed } from "./engine/runtimeFeed";
import { StoryPauseSync } from "./engine/storyPause";
import { useDefaultFont } from "./engine/useDefaultFont";
import { useLiveUpdate } from "./engine/useLiveUpdate";
import { useTextReveal } from "./engine/useTextReveal";
import { useViewportMetrics } from "./viewport/viewport";

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
  // The shared ordered receive path (notification event + sync + responses).
  // It only feeds the window while a bootstrap has established its session.
  const feedRef = useRef<RuntimeFeed | null>(null);
  const feedReadyRef = useRef(false);
  const pauseRef = useRef<StoryPauseSync | null>(null);

  const [status, setStatus] = useState<Status>("booting");
  const { update, effects, receive, setUpdate } = useLiveUpdate();
  const [assets, setAssets] = useState<AssetUrlMap>({});
  const [animations, setAnimations] = useState<AnimationMap>({});
  const [textBlocks, setTextBlocks] = useState<TextBlockMap>({});
  const [particles, setParticles] = useState<ParticleMap>({});
  const [defaultFontId, setDefaultFontId] = useState<string | null>(null);
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

  const view = describePrompt(update);
  const { longText, textPrompt, timelineCue, runtimeTimelineCue, playback } =
    view;
  const reveal = useTextReveal(update, textPrompt, {
    cps: DEFAULT_SETTINGS.text_speed_cps,
    animation: DEFAULT_SETTINGS.text_reveal_animation,
  });
  const { resetLocked: resetLockedTextSettings } = reveal;
  const textInstanceKey = reveal.instanceKey;
  const advanceBlocked = update !== null && isAdvanceBlocked(update.snapshot);
  const runtimeLocked = update?.requires_ack ?? false;
  const forcedAuto = playback.auto === "forced";
  const {
    requested: fastForwardRequested,
    dialogueAllowed: fastForwardDialogueAllowed,
    active: fastForwardActive,
  } = fastForwardState({
    ctrlHeld,
    enabled: status === "playing",
    playback,
    skipMode: DEFAULT_SETTINGS.skip_mode,
    update,
    textPrompt,
    runtimeTimelineCue,
  });

  /**
   * Single entry of every host update (response, event, sync) into the window.
   * Updates of any other session, or arriving while a bootstrap is replacing
   * the session, are dropped here.
   */
  const applyIncoming = useCallback(
    (next: RuntimeUpdate): void => {
      if (!feedReadyRef.current) return;
      if (
        next.session_id !== undefined &&
        next.session_id !== sessionRef.current
      )
        return;
      receive(next);
    },
    [receive],
  );

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
    feedReadyRef.current = false;
    acknowledgedUpdates.current.clear();
    setUpdate(null);
    setStatus("booting");
    setError(null);
    setCompletedPromptKey(null);
    resetLockedTextSettings();
    sceneRef.current?.cancelCurrentPresentation();
    try {
      const payload = await engineApi.secondaryBootstrap();
      const resolved = await engineApi.resolveAssets(payload.asset_ids);
      if (generation !== generationRef.current) return;
      const urls = resolvedAssetsToUrls(resolved);
      setAssets(urls);
      setAnimations(resolvedAssetsToAnimations(resolved));
      setTextBlocks(
        resolveTextBlocks(
          payload.text_blocks ?? {},
          urls,
          payload.default_font,
        ),
      );
      setParticles(payload.particles ?? {});
      setDefaultFontId(payload.default_font ?? null);
      sessionRef.current = requireSessionId(payload.update.session_id);
      // Updates committed since the bootstrap position are fetched in order;
      // anything the listener heard while this was loading is remembered.
      feedRef.current?.sequencer.adopt(sessionRef.current, payload.update.seq);
      feedReadyRef.current = true;
      // The host cleared this window's pause reasons when it re-bootstrapped.
      pauseRef.current?.reset();
      setUpdate(payload.update);
      setStatus("playing");
      await sceneRef.current?.unlockAudio();
    } catch (reason: unknown) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(reason));
      setStatus("failed");
    }
  }, [resetLockedTextSettings, setUpdate]);

  const recoverReplacedSession = useCallback((): void => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    pauseRef.current = new StoryPauseSync((_reason, active) =>
      engineApi.secondarySetStoryPause(sessionRef.current, active),
    );
    return () => {
      pauseRef.current = null;
    };
  }, []);

  // Only a genuinely hidden document counts; moving focus to the other game
  // window never does, so the pair keeps running while either one is visible.
  useEffect(() => {
    pauseRef.current?.set("hidden", pageHidden);
  }, [pageHidden]);

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
    const feed = new RuntimeFeed("secondary", {
      apply: applyIncoming,
      onNewerSession: () => {
        void bootstrap();
      },
      onError: (reason) => {
        if (isStaleSessionError(reason)) recoverReplacedSession();
        else console.error("副窗口更新同步失败", reason);
      },
    });
    feedRef.current = feed;
    const start = async (): Promise<void> => {
      // Both listeners are registered before the first bootstrap.
      await feed.subscribe();
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
      feed.dispose();
      if (feedRef.current === feed) feedRef.current = null;
    };
  }, [applyIncoming, bootstrap, recoverReplacedSession]);

  const fontUrl = defaultFontId === null ? undefined : assets[defaultFontId];
  const fontReady = useDefaultFont(fontUrl, setError);

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
        // Responses take the same ordered path as events: a response that has
        // already been delivered (or overtaken by a newer one) is dropped.
        if (feedRef.current === null) receive(next);
        else feedRef.current.sequencer.offer(next);
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
            // A rejected (typically out-of-date) command: refresh from the
            // host instead of trusting a notification that may have been lost.
            feedRef.current?.sequencer.resync();
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
    [receive, recoverReplacedSession],
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
          snapshot.prompt.kind !== "long_text") ||
        // A script block forbids turning the page (manual, auto and Ctrl alike);
        // the host re-checks authoritatively, this only avoids a doomed request.
        isAdvanceBlocked(snapshot)
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
    // While blocked, auto / forced / Ctrl advance must not keep asking: they
    // resume by themselves when the refresh that lifts the block arrives.
    if (advanceBlocked) return;
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
    advanceBlocked,
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
          textBlocks={textBlocks}
          particles={particles}
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
          effects={effects}
          activeTimers={
            update === null ? null : activeTimerIds(update.snapshot)
          }
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
            <PromptLayers
              animations={animations}
              assets={assets}
              designScale={viewportMetrics.scale}
              dialogueRef={dialogueRef}
              disabled={busy || runtimeLocked}
              fastForward={fastForwardActive}
              fontKey={defaultFontId ?? "system"}
              fontReady={fontReady}
              longTextRef={longTextRef}
              onChoose={choose}
              onDiagnostic={setError}
              onRevealComplete={handleRevealComplete}
              onTypingChange={handleTypingChange}
              reveal={reveal}
              suspended={pageHidden}
              uiMotionHost={uiMotionHost}
              update={update}
              view={view}
            />

            {update.snapshot.prompt.kind === "end" && (
              <div className="end-card">
                <p>副窗口场景结束</p>
                {/* No action: the main window owns the secondary's lifecycle. */}
              </div>
            )}

            <AdvanceBlockNotice
              messages={advanceBlockMessages(update.snapshot)}
            />

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

/**
 * True when the host rejected a request because this window's session was
 * re-pointed. The host uses this code for every stale token, so it is the one
 * signal that must trigger a re-bootstrap rather than a failure screen.
 */
function isStaleSessionError(reason: unknown): boolean {
  return reason instanceof CommandError && reason.code === "stale_session";
}
