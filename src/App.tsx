import { getCurrentWindow } from "@tauri-apps/api/window";
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
import type {
  ProofCheckResult,
  ProofGraph,
} from "@vectspace/presentation-core/proof";
import type { ParticleMap } from "@vectspace/presentation-core/particles";
import {
  requireSessionId,
  SessionTransitionController,
  type SessionTransitionToken,
} from "@vectspace/presentation-core/session-transition";
import { autoReadingDelay, hasImmediateAutoAdvance } from "@vectspace/text";
import {
  activeTimerIds,
  advanceBlockMessages,
  isAdvanceBlocked,
} from "@vectspace/presentation-core/live-update";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import type {
  AdvanceSource,
  AssetUrlMap,
  DialogueHistoryEntry,
  PresentationCue,
  RuntimeUpdate,
  SaveSlotSummary,
  Settings,
  ChapterMapSnapshot,
} from "@vectspace/presentation-core/types";
import { BoundedLedger } from "@vectspace/presentation-core/ledger";

import { errorMessage } from "../shared/commandError";
import type { WireU64 } from "../shared/generated/WireU64";
import { AdvanceBlockNotice } from "./components/AdvanceBlockNotice";
import { ChapterMapPage } from "./components/ChapterMapPage";
import { HistoryPanel } from "./components/HistoryPanel";
import { PromptLayers } from "./components/PromptLayers";
import { SavePanel } from "./components/SavePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { TitleScreen } from "./components/TitleScreen";
import { engineApi } from "./engine/api";
import { getInitialAppState } from "./engine/bootstrap";
import { fastForwardState, isInteractiveTarget } from "./engine/playback";
import { describePrompt } from "./engine/promptView";
import { RuntimeFeed } from "./engine/runtimeFeed";
import { StoryPauseSync } from "./engine/storyPause";
import { useDefaultFont } from "./engine/useDefaultFont";
import { useLiveUpdate } from "./engine/useLiveUpdate";
import { useTextReveal } from "./engine/useTextReveal";
import { useViewportMetrics } from "./viewport/viewport";

const DEFAULT_SETTINGS: Settings = {
  master_volume: 1,
  bgm_volume: 0.7,
  sfx_volume: 0.8,
  video_volume: 1,
  ambience_volume: 0.8,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "read_only",
  reduce_motion: false,
};

type Phase = "booting" | "title" | "chapter_map" | "playing";
type Panel = "none" | "saves" | "settings" | "history";

export default function App(): ReactElement {
  const { metrics: viewportMetrics, style: viewportStyle } =
    useViewportMetrics();
  const sceneRef = useRef<SceneCanvasHandle>(null);
  const dialogueRef = useRef<DialogueBoxHandle>(null);
  const longTextRef = useRef<LongTextPanelHandle>(null);
  const uiMotionHost = useMemo(() => new UiMotionHost(), []);
  const phaseRef = useRef<Phase>("booting");
  const busyRef = useRef(false);
  const acknowledgedUpdates = useRef(new BoundedLedger<string>(256));
  const autosavedRevisions = useRef(new BoundedLedger<string>(256));
  const heldControlKeys = useRef(new Set<string>());
  const replayTransitionRef = useRef<Promise<void> | null>(null);
  const transitionControllerRef = useRef(new SessionTransitionController());
  const commandOwnerRef = useRef(0);
  // Reads used by title/map/history pages are not runtime commands and do not
  // acquire the command lock.  Keep an independent request generation so a
  // late response cannot switch the page after a session boundary has begun.
  const pageRequestGenerationRef = useRef(0);
  // Incremented before every story/replay boundary.  A command that was
  // already in flight may still resolve, but it must not repopulate a page
  // belonging to the new boundary.
  const sessionGenerationRef = useRef(0);
  // Host identity survives clearing presentation state on title/map screens.
  const activeSessionId = useRef("0");
  // The shared ordered receive path (notification event + sync + responses).
  // `feedGenerationRef` is the session generation the sequencer was adopted
  // under: while a boundary is in flight the two differ and every host update
  // of the session being left is dropped instead of resurrecting it.
  const feedRef = useRef<RuntimeFeed | null>(null);
  const feedGenerationRef = useRef(-1);
  const pauseRef = useRef<StoryPauseSync | null>(null);
  // The feed is created once, before `applyIncoming` exists, so it reaches the
  // latest handler through this ref.
  const applyIncomingRef = useRef<(next: RuntimeUpdate) => void>(
    () => undefined,
  );

  const [phase, setPhase] = useState<Phase>("booting");
  const [panel, setPanel] = useState<Panel>("none");
  const { update, effects, receive, setUpdate } = useLiveUpdate();
  const [assets, setAssets] = useState<AssetUrlMap>({});
  const [animations, setAnimations] = useState<AnimationMap>({});
  const [textBlocks, setTextBlocks] = useState<TextBlockMap>({});
  const [particles, setParticles] = useState<ParticleMap>({});
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [draftSettings, setDraftSettings] =
    useState<Settings>(DEFAULT_SETTINGS);
  const [saveSlots, setSaveSlots] = useState<SaveSlotSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contentVersion, setContentVersion] = useState("");
  const [defaultFontId, setDefaultFontId] = useState<string | null>(null);
  const [typingSfxActive, setTypingSfxActive] = useState(false);
  const [typingSfxCps, setTypingSfxCps] = useState(
    DEFAULT_SETTINGS.text_speed_cps,
  );
  const [normalAuto, setNormalAuto] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [pageHidden, setPageHidden] = useState(document.hidden);
  // A stable prompt_id may legitimately be revisited.  Completion belongs to
  // the RuntimeUpdate/presentation instance, never to the story node alone.
  const [completedPromptKey, setCompletedPromptKey] = useState<string | null>(
    null,
  );
  const [history, setHistory] = useState<DialogueHistoryEntry[]>([]);
  const [chapterMap, setChapterMap] = useState<ChapterMapSnapshot | null>(null);
  const [chapterMapAvailable, setChapterMapAvailable] = useState(false);
  const [replayMode, setReplayMode] = useState(false);
  const [replaySceneId, setReplaySceneId] = useState<string | null>(null);
  // Keep the map camera outside the page component so leaving for a replay
  // and returning does not unexpectedly jump back to the author's origin.
  const [chapterMapCenter, setChapterMapCenter] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    let active = true;
    const feed = new RuntimeFeed("main", {
      apply: (next) => applyIncomingRef.current(next),
      onError: (reason) => {
        console.error("主窗口更新同步失败", reason);
      },
    });
    feedRef.current = feed;
    // The notification listener is registered before the bootstrap, so an
    // update committed while the window is still starting is not missed.
    void feed
      .subscribe()
      .then(() => getInitialAppState())
      .then(
        ({
          bootstrap,
          settings: loadedSettings,
          slots,
          assets,
          animations,
        }) => {
          if (!active) {
            return;
          }
          setAssets(assets);
          setAnimations(animations);
          setTextBlocks(
            resolveTextBlocks(
              bootstrap.text_blocks ?? {},
              assets,
              bootstrap.default_font,
            ),
          );
          setParticles(bootstrap.particles ?? {});
          setSettings(loadedSettings);
          setDraftSettings(loadedSettings);
          setSaveSlots(slots);
          sessionGenerationRef.current += 1;
          activeSessionId.current = requireSessionId(
            bootstrap.update.session_id,
          );
          feed.sequencer.adopt(activeSessionId.current, bootstrap.update.seq);
          feedGenerationRef.current = sessionGenerationRef.current;
          // A (re)loaded window starts with no pause reasons on the host.
          pauseRef.current?.reset();
          setUpdate(bootstrap.update);
          setContentVersion(bootstrap.content_version);
          setDefaultFontId(bootstrap.default_font ?? null);
          setChapterMapAvailable(bootstrap.chapter_map_available === true);
          setPhase("title");
        },
      )
      .catch((reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
          setPhase("title");
        }
      });
    return () => {
      active = false;
      feed.dispose();
      if (feedRef.current === feed) feedRef.current = null;
    };
  }, [setUpdate]);

  const fontUrl = defaultFontId === null ? undefined : assets[defaultFontId];
  const fontReady = useDefaultFont(fontUrl, setError);

  const refreshSlots = useCallback(async (): Promise<void> => {
    setSaveSlots(await engineApi.listSaveSlots());
  }, []);

  /**
   * Adopts a story-boundary update (`replace`) or merges a host update of the
   * current session by kind (`receive`): a refresh or timer effect leaves the
   * running presentation, its pending acknowledgement and its text alone.
   */
  const applyUpdate = useCallback(
    (next: RuntimeUpdate, replace = false): void => {
      activeSessionId.current = requireSessionId(next.session_id);
      if (replace) setUpdate(next);
      else receive(next);
      const panelCue = next.cues.find(
        (
          cue,
        ): cue is Extract<PresentationCue, { type: "button_system_action" }> =>
          cue.type === "button_system_action",
      );
      if (panelCue !== undefined) setPanel(panelCue.panel);
    },
    [receive, setUpdate],
  );

  /** Every update the sequencer delivers (event, sync or command response). */
  const applyIncoming = useCallback(
    (next: RuntimeUpdate): void => {
      if (
        phaseRef.current !== "playing" ||
        feedGenerationRef.current !== sessionGenerationRef.current ||
        next.session_id !== activeSessionId.current
      ) {
        return;
      }
      applyUpdate(next);
    },
    [applyUpdate],
  );
  useEffect(() => {
    applyIncomingRef.current = applyIncoming;
  }, [applyIncoming]);

  /** Follows a session the host created for a boundary command. */
  const adoptSession = useCallback(
    (sessionId: WireU64, seq: WireU64 | undefined): void => {
      activeSessionId.current = sessionId;
      feedRef.current?.sequencer.adopt(sessionId, seq);
      feedGenerationRef.current = sessionGenerationRef.current;
      // The host clears this window's pause reasons at every session switch.
      pauseRef.current?.reset();
    },
    [],
  );

  /**
   * Restores the previous authoritative update after a same-session failure.
   *
   * Recovery is instant: the world is hard-aligned without replaying cues and
   * any session curtain left behind by a superseded switch is forced down, so
   * a retryable failure never adds a cover/reveal fade for a switch that did
   * not happen.
   */
  const restoreRetainedUpdate = useCallback(
    async (retained: RuntimeUpdate): Promise<void> => {
      setUpdate(retained);
      // The session did not change: the feed it was following is still valid.
      feedGenerationRef.current = sessionGenerationRef.current;
      let alignmentError: unknown;
      try {
        await sceneRef.current?.applySnapshotImmediately(retained.snapshot);
      } catch (error) {
        alignmentError = error;
      } finally {
        // The curtain is always forced down, even when the hard alignment
        // failed; the alignment error stays the one the caller handles.
        try {
          await sceneRef.current?.revealSession();
        } catch (error) {
          if (alignmentError === undefined) throw error;
        }
      }
      if (alignmentError !== undefined) {
        // The original alignment error is preserved (same Error instance) and
        // never replaced by a curtain error.  A non-Error throw still fails
        // loudly instead of silently succeeding.
        throw alignmentError instanceof Error
          ? alignmentError
          : new Error("Failed to restore the retained update");
      }
    },
    [setUpdate],
  );

  const runStoryCommand = useCallback(
    async (
      command: () => Promise<RuntimeUpdate>,
      generation = sessionGenerationRef.current,
      expectedSessionId = activeSessionId.current,
      allowSessionChange = false,
      expectedMode?: "story" | "replay",
      /** Session switch: align the new world behind the host curtain. */
      sessionBoundary = false,
    ): Promise<boolean> => {
      if (busyRef.current) {
        return false;
      }
      const token = transitionControllerRef.current.begin(
        generation,
        expectedSessionId,
      );
      commandOwnerRef.current = token.id;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const next = await command();
        const returnedSessionId = requireSessionId(next.session_id);
        if (!allowSessionChange && returnedSessionId !== expectedSessionId) {
          throw new Error("运行时返回了不属于当前会话的响应，请重试。");
        }
        if (
          expectedMode !== undefined &&
          next.mode !== undefined &&
          next.mode !== expectedMode
        ) {
          throw new Error("运行时返回了不匹配的会话模式，请重试。");
        }
        // Boundary commands (new game, load and replay start) are allowed to
        // rotate the host session id.  Treat that id change as one atomic
        // commit: the token and generation must still be current, and the
        // active id must still be the id captured when the command began.
        if (allowSessionChange) {
          const current =
            transitionControllerRef.current.isCurrentGeneration(
              token,
              sessionGenerationRef.current,
            ) && activeSessionId.current === expectedSessionId;
          if (current) {
            if (sessionBoundary) {
              // Cover the canvas, hard-align the new world while it is fully
              // black (no cue is replayed) and reveal again after the first
              // stable frame.  A newer transition may supersede this command
              // while the cover is up; if so it owns the world and the UI.
              await sceneRef.current?.applySessionSnapshot(next.snapshot);
              if (
                !transitionControllerRef.current.isCurrentGeneration(
                  token,
                  sessionGenerationRef.current,
                )
              ) {
                return false;
              }
            }
            adoptSession(returnedSessionId, next.seq);
            applyUpdate(next, true);
          }
          return current;
        }
        const current = transitionControllerRef.current.isCurrent(
          token,
          sessionGenerationRef.current,
          activeSessionId.current,
        );
        if (current) {
          // Same ordered path as events: a response that was already delivered
          // (or overtaken) is dropped instead of rolling the window back.
          if (feedRef.current === null) applyUpdate(next);
          else feedRef.current.sequencer.offer(next);
        }
        return current;
      } catch (reason) {
        if (
          transitionControllerRef.current.isCurrent(
            token,
            sessionGenerationRef.current,
            activeSessionId.current,
          )
        ) {
          setError(errorMessage(reason));
          // A rejected (typically out-of-date) command: refresh the view from
          // the host instead of trusting a notification that may have been lost.
          feedRef.current?.sequencer.resync();
        }
        return false;
      } finally {
        if (commandOwnerRef.current === token.id) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [adoptSession, applyUpdate],
  );

  const beginSessionTransition =
    useCallback((): SessionTransitionToken | null => {
      if (busyRef.current || replayTransitionRef.current !== null) return null;
      const token = transitionControllerRef.current.begin(
        sessionGenerationRef.current,
        activeSessionId.current,
      );
      commandOwnerRef.current = token.id;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      return token;
    }, []);

  const stopTransientPlayback = useCallback((): void => {
    // Session boundaries must not inherit input state from the previous
    // page.  In particular a Ctrl key can remain logically pressed when a
    // toolbar click steals focus, and an old typewriter callback can otherwise
    // restart the loop on the first frame of the new session.
    heldControlKeys.current.clear();
    pageRequestGenerationRef.current += 1;
    setCtrlHeld(false);
    setNormalAuto(false);
    setTypingSfxActive(false);
    setCompletedPromptKey(null);
  }, []);

  const finishSessionTransition = useCallback(
    (token: SessionTransitionToken): boolean => {
      if (
        !transitionControllerRef.current.isCurrentGeneration(
          token,
          sessionGenerationRef.current,
        )
      )
        return false;
      if (commandOwnerRef.current === token.id) {
        commandOwnerRef.current = 0;
        busyRef.current = false;
        setBusy(false);
      }
      replayTransitionRef.current = null;
      return true;
    },
    [],
  );

  const handlePresentationSettled = useCallback(
    (
      settled: RuntimeUpdate,
      outcome: "completed" | "skipped" | "failed",
    ): void => {
      if (
        settled.session_id === undefined ||
        settled.session_id !== activeSessionId.current ||
        busyRef.current ||
        (settled.mode !== undefined &&
          settled.mode !== (replayMode ? "replay" : "story"))
      )
        return;
      const settledSessionId = settled.session_id;
      if (settled.requires_ack) {
        if (!acknowledgedUpdates.current.consume(runtimeUpdateKey(settled))) {
          return;
        }
        void runStoryCommand(() =>
          engineApi.presentationComplete(
            settled.update_id,
            outcome,
            settledSessionId,
          ),
        );
        return;
      }

      if (replayMode) return;

      const prompt = settled.snapshot.prompt;
      const isStable = prompt.kind !== "none" && phaseRef.current === "playing";
      if (
        !isStable ||
        autosavedRevisions.current.has(runtimeRevisionKey(settled))
      ) {
        return;
      }
      autosavedRevisions.current.consume(runtimeRevisionKey(settled));
      const thumbnail = sceneRef.current?.captureThumbnail() ?? null;
      void engineApi
        .saveSlot("auto", thumbnail, settledSessionId)
        .then(() => refreshSlots())
        .catch((reason: unknown) => console.error("Autosave failed", reason));
    },
    [refreshSlots, replayMode, runStoryCommand],
  );

  const startNewGame = (): void => {
    void (async () => {
      if (replayTransitionRef.current !== null || busyRef.current) return;
      stopTransientPlayback();
      // A new game is a hard presentation boundary even when it starts from
      // the normal story session.  Leaving an old controller alive until the
      // host response arrives could let a late cue finish/ack or keep media
      // playing behind the newly created runtime.
      sceneRef.current?.cancelCurrentPresentation();
      let expectedSessionId = activeSessionId.current;
      const generation = ++sessionGenerationRef.current;
      if (replayMode) {
        const token = beginSessionTransition();
        if (token === null) return;
        const retainedUpdate = update;
        sceneRef.current?.cancelCurrentPresentation();
        try {
          const nextSessionId = requireSessionId(
            await engineApi.exitSceneReplay(expectedSessionId),
          );
          if (
            !transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          )
            return;
          expectedSessionId = nextSessionId;
          adoptSession(nextSessionId, "0");
          setUpdate(null);
          setReplayMode(false);
          setReplaySceneId(null);
          if (!finishSessionTransition(token)) return;
        } catch (reason) {
          if (
            transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          ) {
            if (retainedUpdate !== null) {
              await restoreRetainedUpdate(retainedUpdate);
            }
            setError(errorMessage(reason));
            finishSessionTransition(token);
          }
          return;
        }
      }
      setReplayMode(false);
      setReplaySceneId(null);
      autosavedRevisions.current.clear();
      setHistory([]);
      // Do not let the previous scene remain visible while the boundary
      // command is in flight.  The command response is the only source that
      // may install the new authoritative update.
      setUpdate(null);
      setPhase("playing");
      phaseRef.current = "playing";
      setPanel("none");
      void sceneRef.current?.unlockAudio();
      const started = await runStoryCommand(
        () => engineApi.startNewGame(expectedSessionId),
        generation,
        expectedSessionId,
        true,
        "story",
        true,
      );
      // A failed boundary command must not leave the title screen in a
      // half-entered story session. Only the transition that started this
      // command may restore the page; a newer transition owns the UI.
      if (
        !started &&
        generation === sessionGenerationRef.current &&
        activeSessionId.current === expectedSessionId
      ) {
        setPhase("title");
        phaseRef.current = "title";
        setPanel("none");
        setUpdate(null);
      }
    })();
  };

  const advance = useCallback(
    (source: AdvanceSource): void => {
      const snapshot = update?.snapshot;
      if (
        snapshot === undefined ||
        (snapshot.prompt.kind !== "dialogue" &&
          snapshot.prompt.kind !== "long_text") ||
        // A script block forbids turning the page (manual, auto and Ctrl
        // alike); the host re-checks authoritatively, this only avoids a
        // doomed request.  Choices and other buttons are not affected.
        isAdvanceBlocked(snapshot)
      ) {
        return;
      }
      void runStoryCommand(() =>
        engineApi.advance(snapshot.revision, source, activeSessionId.current),
      );
    },
    [runStoryCommand, update],
  );

  const choose = (choiceId: string): void => {
    const snapshot = update?.snapshot;
    if (snapshot === undefined || snapshot.prompt.kind !== "choice") {
      return;
    }
    void runStoryCommand(() =>
      engineApi.choose(choiceId, snapshot.revision, activeSessionId.current),
    );
  };

  const submitProof = async (
    graph: ProofGraph,
  ): Promise<{ accepted: boolean; check: ProofCheckResult }> => {
    const retained = update;
    const snapshot = retained?.snapshot;
    if (!retained || snapshot?.prompt.kind !== "proof")
      throw new Error("当前没有进行中的证明题。");
    let response: { accepted: boolean; check: ProofCheckResult } | null = null;
    const applied = await runStoryCommand(async () => {
      const submitted = await engineApi.proofSubmit(
        snapshot.revision,
        graph,
        activeSessionId.current,
      );
      response = submitted;
      // An incomplete submission leaves the current runtime untouched.
      return submitted.update ?? retained;
    });
    if (!applied || response === null)
      throw new Error("证明提交失败，请重试。");
    return response;
  };

  const abandonProof = (): void => {
    const snapshot = update?.snapshot;
    if (snapshot?.prompt.kind !== "proof" || !snapshot.prompt.can_abandon)
      return;
    void runStoryCommand(() =>
      engineApi.proofAbandon(snapshot.revision, activeSessionId.current),
    );
  };

  const clickButton = useCallback(
    (instanceId: string): void => {
      const snapshot = update?.snapshot;
      if (
        snapshot === undefined ||
        phaseRef.current !== "playing" ||
        panel !== "none" ||
        busyRef.current ||
        update?.requires_ack
      ) {
        return;
      }
      void runStoryCommand(() =>
        engineApi.clickButton(
          instanceId,
          snapshot.revision,
          activeSessionId.current,
        ),
      );
    },
    [panel, runStoryCommand, update],
  );

  const saveManual = async (slot: string): Promise<void> => {
    if (busyRef.current) {
      return;
    }
    setError(null);
    try {
      await engineApi.saveSlot(
        slot,
        sceneRef.current?.captureThumbnail() ?? null,
        activeSessionId.current,
      );
      await refreshSlots();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const load = (slot: string): void => {
    if (replayMode || busyRef.current || replayTransitionRef.current !== null)
      return;
    stopTransientPlayback();
    // Loading is also a session boundary.  Cancel the old presentation
    // before clearing its update so delayed cue/media callbacks cannot leak
    // across the asynchronous host transition.
    sceneRef.current?.cancelCurrentPresentation();
    const generation = ++sessionGenerationRef.current;
    const expectedSessionId = activeSessionId.current;
    autosavedRevisions.current.clear();
    setHistory([]);
    // A load is a session boundary.  Clear the old presentation before the
    // asynchronous command so a failed load cannot show a mixed scene.
    setUpdate(null);
    setPhase("playing");
    phaseRef.current = "playing";
    setPanel("none");
    void sceneRef.current?.unlockAudio();
    void runStoryCommand(
      () => engineApi.loadSlot(slot, expectedSessionId),
      generation,
      expectedSessionId,
      true,
      "story",
      true,
    ).then((loaded) => {
      // Keep the title page when loading fails. The generation/session guard
      // prevents an older load from undoing a newer boundary transition.
      if (
        !loaded &&
        generation === sessionGenerationRef.current &&
        activeSessionId.current === expectedSessionId
      ) {
        setPhase("title");
        phaseRef.current = "title";
        setPanel("none");
      }
    });
  };

  const persistSettings = async (): Promise<void> => {
    try {
      const saved = await engineApi.saveSettings(draftSettings);
      setSettings(saved);
      setDraftSettings(saved);
      setPanel("none");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const toggleFullscreen = async (): Promise<void> => {
    try {
      const window = getCurrentWindow();
      await window.setFullscreen(!(await window.isFullscreen()));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const returnToTitle = (): void => {
    if (busyRef.current) return;
    stopTransientPlayback();
    if (replayMode) {
      if (replayTransitionRef.current !== null) return;
      const generation = ++sessionGenerationRef.current;
      const token = beginSessionTransition();
      if (token === null) return;
      const retainedUpdate = update;
      const transition = (async () => {
        sceneRef.current?.cancelCurrentPresentation();
        try {
          const nextSessionId = requireSessionId(
            await engineApi.exitSceneReplay(activeSessionId.current),
          );
          if (
            !transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          )
            return;
          adoptSession(nextSessionId, "0");
          setUpdate(null);
          setReplayMode(false);
          setReplaySceneId(null);
          setHistory([]);
          setPanel("none");
          setPhase("title");
          phaseRef.current = "title";
          finishSessionTransition(token);
        } catch (reason) {
          if (
            transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          ) {
            // The presentation was cancelled before the host call, but the
            // authoritative update remains visible so the user can retry.
            if (retainedUpdate !== null) {
              await restoreRetainedUpdate(retainedUpdate);
            }
            setError(errorMessage(reason));
            finishSessionTransition(token);
          }
        } finally {
          if (
            transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          )
            replayTransitionRef.current = null;
        }
      })();
      replayTransitionRef.current = transition;
      return;
    }
    const generation = ++sessionGenerationRef.current;
    const token = beginSessionTransition();
    if (token === null) return;
    const retainedUpdate = update;
    setReplayMode(false);
    setReplaySceneId(null);
    // Leaving the story must invalidate the active presentation as well as
    // hiding it.  Otherwise a late cue completion can still ack the runtime
    // after the title screen is visible (and an audio/video element can keep
    // running behind the menu).
    sceneRef.current?.cancelCurrentPresentation();
    void (async () => {
      try {
        const nextSessionId = requireSessionId(
          await engineApi.invalidateSession(activeSessionId.current),
        );
        if (
          !transitionControllerRef.current.isCurrentGeneration(
            token,
            generation,
          )
        )
          return;
        adoptSession(nextSessionId, "0");
        setUpdate(null);
        setPhase("title");
        phaseRef.current = "title";
        finishSessionTransition(token);
      } catch (reason) {
        if (
          transitionControllerRef.current.isCurrentGeneration(token, generation)
        ) {
          if (retainedUpdate !== null) {
            await restoreRetainedUpdate(retainedUpdate);
          }
          setError(errorMessage(reason));
          finishSessionTransition(token);
        }
      }
    })();
    setHistory([]);
    setPanel("none");
  };

  const openHistory = (): void => {
    const requestGeneration = ++pageRequestGenerationRef.current;
    const requestSessionId = activeSessionId.current;
    void engineApi
      .getDialogueHistory()
      .then((entries) => {
        if (
          requestGeneration !== pageRequestGenerationRef.current ||
          requestSessionId !== activeSessionId.current ||
          phaseRef.current !== "playing"
        )
          return;
        setHistory(entries);
        setPanel("history");
      })
      .catch((reason: unknown) => {
        if (
          requestGeneration === pageRequestGenerationRef.current &&
          requestSessionId === activeSessionId.current &&
          phaseRef.current === "playing"
        )
          setError(errorMessage(reason));
      });
  };

  const openChapterMap = (): void => {
    const requestGeneration = ++pageRequestGenerationRef.current;
    const requestSessionId = activeSessionId.current;
    void engineApi
      .getChapterMap()
      .then((map) => {
        if (
          requestGeneration !== pageRequestGenerationRef.current ||
          requestSessionId !== activeSessionId.current ||
          phaseRef.current !== "title"
        )
          return;
        if (map === null) {
          setError("当前内容未配置章节地图。");
          return;
        }
        setChapterMap(map);
        setNormalAuto(false);
        setPanel("none");
        setPhase("chapter_map");
        phaseRef.current = "chapter_map";
      })
      .catch((reason: unknown) => {
        if (
          requestGeneration === pageRequestGenerationRef.current &&
          requestSessionId === activeSessionId.current &&
          phaseRef.current === "title"
        )
          setError(errorMessage(reason));
      });
  };

  const startSceneReplay = (sceneId: string): void => {
    if (busyRef.current || replayTransitionRef.current !== null) return;
    stopTransientPlayback();
    const generation = ++sessionGenerationRef.current;
    const expectedSessionId = activeSessionId.current;
    setError(null);
    // Do not let the previous story update briefly render behind the replay
    // while the host constructs its isolated runtime.
    setUpdate(null);
    sceneRef.current?.cancelCurrentPresentation();
    setReplayMode(true);
    setReplaySceneId(sceneId);
    setPanel("none");
    setPhase("playing");
    phaseRef.current = "playing";
    // The whole transition, including the map refresh after a failed replay
    // start, stays behind one controller-owned token: releasing `busy` as soon
    // as `start_scene_replay` settles would expose a blank playing screen in
    // which a second command could race the map recovery.
    const transition = (async () => {
      try {
        const started = await runStoryCommand(
          () => engineApi.startSceneReplay(sceneId, expectedSessionId),
          generation,
          expectedSessionId,
          true,
          "replay",
          true,
        );
        if (generation !== sessionGenerationRef.current || started) return;
        // Keep a failed replay from leaving the game controls over a stale
        // main-story snapshot.  The map remains the authoritative place to
        // retry, and its current camera is preserved in the parent state.
        const map = await engineApi.getChapterMap();
        if (generation !== sessionGenerationRef.current) return;
        setChapterMap(map);
        setReplayMode(false);
        setReplaySceneId(null);
        setPhase("chapter_map");
        phaseRef.current = "chapter_map";
      } catch (reason: unknown) {
        if (generation !== sessionGenerationRef.current) return;
        setReplayMode(false);
        setReplaySceneId(null);
        setPhase("chapter_map");
        phaseRef.current = "chapter_map";
        setError(errorMessage(reason));
      } finally {
        if (generation === sessionGenerationRef.current)
          replayTransitionRef.current = null;
      }
    })();
    replayTransitionRef.current = transition;
  };

  const finishSceneReplay = useCallback((): void => {
    if (replayTransitionRef.current !== null) return;
    stopTransientPlayback();
    const generation = ++sessionGenerationRef.current;
    const token = beginSessionTransition();
    if (token === null) return;
    const retainedUpdate = update;
    const expectedSessionId = activeSessionId.current;
    let exitedSessionId: WireU64 | null = null;
    const transition = (async () => {
      sceneRef.current?.cancelCurrentPresentation();
      try {
        const nextSessionId = requireSessionId(
          await engineApi.exitSceneReplay(expectedSessionId),
        );
        if (
          !transitionControllerRef.current.isCurrentGeneration(
            token,
            generation,
          )
        )
          return;
        // Keep the replay frame visible until the map has been fetched.  A
        // failed exit call must leave the exact frame the player was looking
        // at; a successful host switch followed by a map read failure is a
        // different case and can fall back to the already loaded map.
        exitedSessionId = nextSessionId;
        const map = await engineApi.getChapterMap();
        if (
          !transitionControllerRef.current.isCurrentGeneration(
            token,
            generation,
          )
        )
          return;
        adoptSession(nextSessionId, "0");
        setChapterMap(map);
        setUpdate(null);
        setReplayMode(false);
        setReplaySceneId(null);
        setPanel("none");
        setPhase("chapter_map");
        phaseRef.current = "chapter_map";
        finishSessionTransition(token);
      } catch (reason) {
        if (
          transitionControllerRef.current.isCurrentGeneration(token, generation)
        ) {
          if (exitedSessionId === null) {
            if (retainedUpdate !== null) {
              await restoreRetainedUpdate(retainedUpdate);
            }
          } else {
            // The host is already back in story mode.  Do not leave replay
            // controls attached to an update that can no longer be acked;
            // show the existing map and let the user retry the read instead.
            adoptSession(exitedSessionId, "0");
            setUpdate(null);
            setReplayMode(false);
            setReplaySceneId(null);
            setPanel("none");
            setPhase("chapter_map");
            phaseRef.current = "chapter_map";
          }
          setError(errorMessage(reason));
          finishSessionTransition(token);
        }
      } finally {
        if (
          transitionControllerRef.current.isCurrentGeneration(token, generation)
        )
          replayTransitionRef.current = null;
      }
    })();
    replayTransitionRef.current = transition;
  }, [
    adoptSession,
    beginSessionTransition,
    finishSessionTransition,
    restoreRetainedUpdate,
    setUpdate,
    stopTransientPlayback,
    update,
  ]);

  useEffect(() => {
    if (!replayMode || replaySceneId === null || update === null) return;
    const crossed = update.snapshot.location.scene_id !== replaySceneId;
    const ended = update.snapshot.prompt.kind === "end";
    if ((crossed || ended) && !update.requires_ack) {
      const frame = requestAnimationFrame(finishSceneReplay);
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [finishSceneReplay, replayMode, replaySceneId, update]);

  const closeChapterMap = (): void => {
    if (busyRef.current || replayTransitionRef.current !== null) return;
    setPhase("title");
    phaseRef.current = "title";
  };

  const view = describePrompt(update);
  const { longText, textPrompt, timelineCue, runtimeTimelineCue, playback } =
    view;
  const reveal = useTextReveal(update, textPrompt, {
    cps: settings.text_speed_cps,
    animation: settings.text_reveal_animation,
  });
  const textInstanceKey = reveal.instanceKey;
  const advanceBlocked = update !== null && isAdvanceBlocked(update.snapshot);
  const runtimeLocked = update?.requires_ack ?? false;
  const forcedAuto = playback.auto === "forced";
  const immediateAutoAdvance =
    textPrompt !== null && hasImmediateAutoAdvance(textPrompt.text);
  const {
    requested: fastForwardRequested,
    dialogueAllowed: fastForwardDialogueAllowed,
    active: fastForwardActive,
  } = fastForwardState({
    ctrlHeld,
    enabled: phase === "playing" && panel === "none",
    playback,
    skipMode: settings.skip_mode,
    update,
    textPrompt,
    runtimeTimelineCue,
  });
  const autoSlot = saveSlots.find((slot) => slot.slot === "auto");
  const handleTypingChange = useCallback(
    (typing: boolean, cps: number): void => {
      setTypingSfxActive(typing);
      setTypingSfxCps(cps);
    },
    [],
  );
  const handlePlayerAdvance = useCallback((): void => {
    if (
      phaseRef.current !== "playing" ||
      panel !== "none" ||
      busyRef.current ||
      (!runtimeLocked &&
        (textPrompt === null ||
          (longText === null && !update?.snapshot.world.dialogue_ui_visible)))
    ) {
      return;
    }

    void sceneRef.current?.unlockAudio();
    if (forcedAuto) {
      return;
    }
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
  }, [advance, forcedAuto, longText, panel, runtimeLocked, textPrompt, update]);

  const handleRevealComplete = useCallback((instanceKey: string): void => {
    setCompletedPromptKey(instanceKey);
  }, []);

  useEffect(() => {
    if (
      phase !== "playing" ||
      panel !== "none" ||
      busy ||
      runtimeLocked ||
      textPrompt === null ||
      !fastForwardRequested ||
      !fastForwardDialogueAllowed
    ) {
      return;
    }

    // Ctrl is a request to finish the current reveal, including an explicit
    // pause. It must happen before the completion gate below; otherwise a
    // held Ctrl key can never leave a prompt that is still typing or paused.
    // The component reports completion asynchronously, so the normal
    // revision-safe advance effect remains the only place that advances.
    if (longText === null) dialogueRef.current?.complete();
    else longTextRef.current?.complete();
  }, [
    busy,
    fastForwardDialogueAllowed,
    fastForwardRequested,
    longText,
    panel,
    phase,
    runtimeLocked,
    textPrompt,
  ]);

  useEffect(() => {
    if (
      phase !== "playing" ||
      panel !== "none" ||
      busy ||
      runtimeLocked ||
      // While blocked, auto / forced / Ctrl advance must not keep asking: they
      // resume by themselves when the refresh that lifts the block arrives.
      advanceBlocked ||
      textPrompt === null
    ) {
      return;
    }

    let timer = 0;
    if (completedPromptKey !== textInstanceKey) return;
    if (immediateAutoAdvance) {
      timer = window.setTimeout(
        () => advance(forcedAuto ? "forced_auto" : "auto"),
        0,
      );
    } else if (forcedAuto) {
      timer = window.setTimeout(
        () => advance("forced_auto"),
        autoReadingDelay(textPrompt.text),
      );
    } else if (fastForwardRequested) {
      if (!fastForwardDialogueAllowed) return;
      timer = window.setTimeout(() => advance("fast_forward"), 50);
    } else if (normalAuto && completedPromptKey === textInstanceKey) {
      timer = window.setTimeout(
        () => advance("auto"),
        autoReadingDelay(textPrompt.text),
      );
    }
    return () => window.clearTimeout(timer);
  }, [
    advance,
    advanceBlocked,
    busy,
    completedPromptKey,
    textPrompt,
    textInstanceKey,
    fastForwardDialogueAllowed,
    fastForwardRequested,
    forcedAuto,
    immediateAutoAdvance,
    normalAuto,
    panel,
    phase,
    runtimeLocked,
    longText,
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
        heldControlKeys.current.add(event.code);
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
      heldControlKeys.current.delete(event.code);
      setCtrlHeld(heldControlKeys.current.size > 0);
    };
    const clearControlKeys = (): void => {
      heldControlKeys.current.clear();
      setCtrlHeld(false);
    };
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

  useEffect(() => {
    const closePanel = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && panel === "history") {
        event.preventDefault();
        setPanel("none");
      }
    };
    window.addEventListener("keydown", closePanel);
    return () => window.removeEventListener("keydown", closePanel);
  }, [panel, phase]);

  // The host owns the story clock.  The window only reports why it would pause
  // it: an open save / settings / history panel, or a really hidden document.
  // Merely focusing the other game window is neither, so it never pauses.
  useEffect(() => {
    pauseRef.current = new StoryPauseSync((reason, active) =>
      engineApi.setStoryPause(activeSessionId.current, reason, active),
    );
    return () => {
      pauseRef.current = null;
    };
  }, []);

  useEffect(() => {
    pauseRef.current?.set("hidden", pageHidden);
  }, [pageHidden]);

  useEffect(() => {
    pauseRef.current?.set(
      "panel",
      (panel !== "none" || update?.snapshot.prompt.kind === "proof") &&
        phase === "playing",
    );
  }, [panel, phase, update?.snapshot.prompt.kind]);

  // Opening any in-game panel is a hard input boundary.  In particular a
  // Ctrl key that was held while clicking the toolbar must not resume a
  // fast-forward as soon as the panel closes (the key-up event may have been
  // delivered to the panel/WebView instead of the game surface).
  useEffect(() => {
    if (panel !== "none") {
      heldControlKeys.current.clear();
      const frame = requestAnimationFrame(() => setCtrlHeld(false));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [panel]);

  return (
    <main className="app-shell">
      <section className="game-viewport" style={viewportStyle}>
        <SceneCanvas
          animations={animations}
          textBlocks={textBlocks}
          particles={particles}
          assets={assets}
          onDiagnostic={setError}
          onSettled={handlePresentationSettled}
          paused={panel !== "none" || phase !== "playing" || pageHidden}
          playbackRate={fastForwardActive ? 8 : 1}
          ref={sceneRef}
          settings={settings}
          suppressOneShots={fastForwardActive}
          typingSfxActive={typingSfxActive && !fastForwardActive}
          typingSfxCps={typingSfxCps}
          update={update}
          effects={effects}
          activeTimers={
            update === null ? null : activeTimerIds(update.snapshot)
          }
          uiMotionHost={uiMotionHost}
          visible={phase === "playing"}
        />

        {phase === "playing" && update !== null && (
          <ButtonLayer
            animations={animations}
            assets={assets}
            disabled={panel !== "none" || busy || runtimeLocked}
            onClick={clickButton}
            paused={panel !== "none" || phase !== "playing" || pageHidden}
            playbackRate={fastForwardActive ? 8 : 1}
            snapshot={update.snapshot}
            timeline={timelineCue ?? null}
          />
        )}

        {phase === "booting" && (
          <div className="boot-screen">
            <div className="loader" />
            <p>正在校验内容与启动运行时…</p>
          </div>
        )}

        {phase === "title" && (
          <TitleScreen
            busy={busy}
            canContinue={autoSlot?.exists === true}
            chapterMapAvailable={chapterMapAvailable}
            contentVersion={contentVersion}
            onContinue={() => load("auto")}
            onOpenChapterMap={openChapterMap}
            onOpenSaves={() => setPanel("saves")}
            onOpenSettings={() => setPanel("settings")}
            onStart={startNewGame}
          />
        )}

        {phase === "chapter_map" && chapterMap !== null && (
          <ChapterMapPage
            animations={animations}
            assets={assets}
            map={chapterMap}
            onClose={closeChapterMap}
            onReplay={startSceneReplay}
            onViewChange={setChapterMapCenter}
            paused={pageHidden}
            sessionCenter={chapterMapCenter}
          />
        )}

        {phase === "playing" && update !== null && (
          <>
            <nav className="game-toolbar" aria-label="游戏菜单">
              <button
                aria-pressed={normalAuto}
                disabled={forcedAuto}
                onClick={() => setNormalAuto((value) => !value)}
                type="button"
              >
                {forcedAuto
                  ? "自动（强制）"
                  : normalAuto
                    ? "自动：开"
                    : "自动：关"}
              </button>
              {!replayMode && (
                <button onClick={() => setPanel("saves")} type="button">
                  存档 / 读档
                </button>
              )}
              <button onClick={() => setPanel("settings")} type="button">
                设置
              </button>
              <button onClick={openHistory} type="button">
                历史
              </button>
              <button onClick={() => void toggleFullscreen()} type="button">
                全屏
              </button>
              <button onClick={returnToTitle} type="button">
                标题
              </button>
            </nav>

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
              onProofSubmit={submitProof}
              onProofAbandon={abandonProof}
              onChoose={choose}
              onDiagnostic={setError}
              onRevealComplete={handleRevealComplete}
              onTypingChange={handleTypingChange}
              reveal={reveal}
              suspended={panel !== "none" || pageHidden}
              uiMotionHost={uiMotionHost}
              update={update}
              view={view}
            />

            {update.snapshot.prompt.kind === "end" && (
              <div className="end-card">
                <p>{replayMode ? "章节重演结束" : "演示场景结束"}</p>
                <button
                  onClick={replayMode ? finishSceneReplay : returnToTitle}
                  type="button"
                >
                  {replayMode ? "返回章节地图" : "返回标题"}
                </button>
              </div>
            )}

            <AdvanceBlockNotice
              messages={advanceBlockMessages(update.snapshot)}
            />

            {runtimeLocked && <div className="runtime-lock">表现同步中…</div>}
          </>
        )}

        {panel === "saves" && (
          <SavePanel
            canSave={phase === "playing" && !runtimeLocked && !replayMode}
            onClose={() => setPanel("none")}
            onLoad={load}
            onSave={(slot) => void saveManual(slot)}
            slots={saveSlots}
          />
        )}

        {panel === "settings" && (
          <SettingsPanel
            onChange={setDraftSettings}
            onClose={() => {
              setDraftSettings(settings);
              setPanel("none");
            }}
            onSave={() => void persistSettings()}
            settings={draftSettings}
          />
        )}

        {panel === "history" && (
          <HistoryPanel entries={history} onClose={() => setPanel("none")} />
        )}
        {error !== null && (
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

function runtimeUpdateKey(update: RuntimeUpdate): string {
  return `${update.session_id ?? "0"}:${update.update_id}`;
}

function runtimeRevisionKey(update: RuntimeUpdate): string {
  return `${update.session_id ?? "0"}:${update.snapshot.revision}`;
}
