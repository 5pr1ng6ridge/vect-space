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

import { DialogueBox, type DialogueBoxHandle } from "./components/DialogueBox";
import { HistoryPanel } from "./components/HistoryPanel";
import {
  LongTextPanel,
  type LongTextPanelHandle,
} from "./components/LongTextPanel";
import { MarkupText } from "./components/MarkupText";
import { SceneCanvas, type SceneCanvasHandle } from "./components/SceneCanvas";
import { StoryFlowPage } from "./components/StoryFlowPage";
import { engineApi, resolvedAssetsToUrls } from "./engine/api";
import {
  autoReadingDelay,
  buildRevealSchedule,
  hasImmediateAutoAdvance,
  parseMarkup,
} from "./engine/markup";
import { canFastForwardPrompt } from "./engine/playback";
import { UiMotionHost } from "./engine/uiMotion";
import type {
  AdvanceSource,
  AssetUrlMap,
  BootstrapPayload,
  ChoicePrompt,
  DialoguePrompt,
  DialogueHistoryEntry,
  LongTextPrompt,
  PresentationCue,
  RuntimeUpdate,
  SaveSlotSummary,
  Settings,
  StoryFlowSnapshot,
  TextRevealAnimation,
} from "./engine/types";
import { useViewportMetrics } from "./viewport/viewport";
import { BoundedLedger } from "@vectspace/presentation-core/ledger";

const DEFAULT_SETTINGS: Settings = {
  master_volume: 1,
  bgm_volume: 0.7,
  sfx_volume: 0.8,
  video_volume: 1,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "read_only",
};

type Phase = "booting" | "title" | "story_flow" | "playing";
type Panel = "none" | "saves" | "settings" | "history";

interface InitialAppState {
  bootstrap: BootstrapPayload;
  settings: Settings;
  slots: SaveSlotSummary[];
  assets: AssetUrlMap;
}

interface LockedTextSettings {
  promptId: string;
  defaultCps: number;
  initialCps: number;
  animation: TextRevealAnimation;
}

let initialAppStatePromise: Promise<InitialAppState> | null = null;

export default function App(): ReactElement {
  const { metrics: viewportMetrics, style: viewportStyle } =
    useViewportMetrics();
  const sceneRef = useRef<SceneCanvasHandle>(null);
  const dialogueRef = useRef<DialogueBoxHandle>(null);
  const longTextRef = useRef<LongTextPanelHandle>(null);
  const uiMotionHost = useMemo(() => new UiMotionHost(), []);
  const phaseRef = useRef<Phase>("booting");
  const busyRef = useRef(false);
  const acknowledgedUpdates = useRef(new BoundedLedger<number>(256));
  const autosavedRevisions = useRef(new BoundedLedger<number>(256));
  const heldControlKeys = useRef(new Set<string>());

  const [phase, setPhase] = useState<Phase>("booting");
  const [panel, setPanel] = useState<Panel>("none");
  const [update, setUpdate] = useState<RuntimeUpdate | null>(null);
  const [assets, setAssets] = useState<AssetUrlMap>({});
  const [loadedFontUrl, setLoadedFontUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [draftSettings, setDraftSettings] =
    useState<Settings>(DEFAULT_SETTINGS);
  const [saveSlots, setSaveSlots] = useState<SaveSlotSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contentVersion, setContentVersion] = useState("");
  const [typingSfxActive, setTypingSfxActive] = useState(false);
  const [typingSfxCps, setTypingSfxCps] = useState(
    DEFAULT_SETTINGS.text_speed_cps,
  );
  const [normalAuto, setNormalAuto] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [pageHidden, setPageHidden] = useState(document.hidden);
  const [completedPromptId, setCompletedPromptId] = useState<string | null>(
    null,
  );
  const [history, setHistory] = useState<DialogueHistoryEntry[]>([]);
  const [storyFlow, setStoryFlow] = useState<StoryFlowSnapshot | null>(null);
  const [storyFlowAvailable, setStoryFlowAvailable] = useState(false);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    let active = true;
    void getInitialAppState()
      .then(({ bootstrap, settings: loadedSettings, slots, assets }) => {
        if (!active) {
          return;
        }
        setAssets(assets);
        setSettings(loadedSettings);
        setDraftSettings(loadedSettings);
        setSaveSlots(slots);
        setUpdate(bootstrap.update);
        setContentVersion(bootstrap.content_version);
        setStoryFlowAvailable(bootstrap.story_flow_available);
        setPhase("title");
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
          setPhase("title");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const fontUrl = assets["font.fusion_pixel"];
    if (fontUrl === undefined) {
      return;
    }
    let active = true;
    const face = new FontFace("VECT Pixel", `url("${fontUrl}")`, {
      display: "swap",
    });
    document.fonts.add(face);
    void face
      .load()
      .catch((reason: unknown) => {
        if (active) {
          setError(`中文字体加载失败：${errorMessage(reason)}`);
        }
      })
      .finally(() => {
        if (active) setLoadedFontUrl(fontUrl);
      });
    return () => {
      active = false;
      document.fonts.delete(face);
    };
  }, [assets]);

  const fontUrl = assets["font.fusion_pixel"];
  const fontReady = fontUrl === undefined || loadedFontUrl === fontUrl;

  const refreshSlots = useCallback(async (): Promise<void> => {
    setSaveSlots(await engineApi.listSaveSlots());
  }, []);

  const applyUpdate = useCallback((next: RuntimeUpdate): void => {
    setUpdate(next);
  }, []);

  const runStoryCommand = useCallback(
    async (command: () => Promise<RuntimeUpdate>): Promise<void> => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        applyUpdate(await command());
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [applyUpdate],
  );

  const handlePresentationSettled = useCallback(
    (
      settled: RuntimeUpdate,
      outcome: "completed" | "skipped" | "failed",
    ): void => {
      if (settled.requires_ack) {
        if (!acknowledgedUpdates.current.consume(settled.update_id)) {
          return;
        }
        void runStoryCommand(() =>
          engineApi.presentationComplete(settled.update_id, outcome),
        );
        return;
      }

      const prompt = settled.snapshot.prompt;
      const isStable = prompt.kind !== "none" && phaseRef.current === "playing";
      if (
        !isStable ||
        autosavedRevisions.current.has(settled.snapshot.revision)
      ) {
        return;
      }
      autosavedRevisions.current.consume(settled.snapshot.revision);
      const thumbnail = sceneRef.current?.captureThumbnail() ?? null;
      void engineApi
        .saveSlot("auto", thumbnail)
        .then(() => refreshSlots())
        .catch((reason: unknown) => console.error("Autosave failed", reason));
    },
    [refreshSlots, runStoryCommand],
  );

  const startNewGame = (): void => {
    autosavedRevisions.current.clear();
    setNormalAuto(false);
    setPhase("playing");
    phaseRef.current = "playing";
    setPanel("none");
    void sceneRef.current?.unlockAudio();
    void runStoryCommand(engineApi.startNewGame);
  };

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
      void runStoryCommand(() => engineApi.advance(snapshot.revision, source));
    },
    [runStoryCommand, update],
  );

  const choose = (choiceId: string): void => {
    const snapshot = update?.snapshot;
    if (snapshot === undefined || snapshot.prompt.kind !== "choice") {
      return;
    }
    void runStoryCommand(() => engineApi.choose(choiceId, snapshot.revision));
  };

  const saveManual = async (slot: string): Promise<void> => {
    if (busyRef.current) {
      return;
    }
    setError(null);
    try {
      await engineApi.saveSlot(
        slot,
        sceneRef.current?.captureThumbnail() ?? null,
      );
      await refreshSlots();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const load = (slot: string): void => {
    autosavedRevisions.current.clear();
    setNormalAuto(false);
    setPhase("playing");
    phaseRef.current = "playing";
    setPanel("none");
    void sceneRef.current?.unlockAudio();
    void runStoryCommand(() => engineApi.loadSlot(slot));
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
    setNormalAuto(false);
    setPanel("none");
    setPhase("title");
    phaseRef.current = "title";
  };

  const openHistory = (): void => {
    void engineApi
      .getDialogueHistory()
      .then((entries) => {
        setHistory(entries);
        setPanel("history");
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  };

  const openStoryFlow = (): void => {
    void engineApi
      .getStoryFlow()
      .then((flow) => {
        if (flow === null) {
          setError("当前内容未配置剧情流程。");
          return;
        }
        setStoryFlow(flow);
        setNormalAuto(false);
        setPanel("none");
        setPhase("story_flow");
        phaseRef.current = "story_flow";
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  };

  const closeStoryFlow = (): void => {
    setPhase("title");
    phaseRef.current = "title";
  };

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
  const currentTextSettings = useMemo<LockedTextSettings | null>(() => {
    if (textPrompt === null) return null;
    return {
      promptId: textPrompt.prompt_id,
      defaultCps: settings.text_speed_cps,
      initialCps: textCueCps ?? settings.text_speed_cps,
      animation: cueRevealAnimation ?? settings.text_reveal_animation,
    };
  }, [cueRevealAnimation, settings, textCueCps, textPrompt]);
  const [lockedTextSettings, setLockedTextSettings] =
    useState<LockedTextSettings | null>(null);
  useEffect(() => {
    if (currentTextSettings === null) {
      const frame = requestAnimationFrame(() => setLockedTextSettings(null));
      return () => cancelAnimationFrame(frame);
    }
    const frame = requestAnimationFrame(() => {
      setLockedTextSettings((previous) =>
        previous?.promptId === currentTextSettings.promptId
          ? previous
          : currentTextSettings,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [currentTextSettings]);
  const effectiveTextSettings =
    lockedTextSettings?.promptId === currentTextSettings?.promptId
      ? lockedTextSettings
      : currentTextSettings;
  const revealCps =
    effectiveTextSettings?.initialCps ?? settings.text_speed_cps;
  const revealDefaultCps =
    effectiveTextSettings?.defaultCps ?? settings.text_speed_cps;
  const revealAnimation =
    effectiveTextSettings?.animation ?? settings.text_reveal_animation;
  const runtimeLocked = update?.requires_ack ?? false;
  const activeTimelineCue = update?.cues.find(
    (cue): cue is Extract<PresentationCue, { type: "timeline" }> =>
      cue.type === "timeline" && cue.gate === "runtime",
  );
  const playback = update?.snapshot.playback ?? {
    auto: "normal" as const,
    ctrl_fast_forward: "allow" as const,
  };
  const forcedAuto = playback.auto === "forced";
  const immediateAutoAdvance =
    textPrompt !== null && hasImmediateAutoAdvance(textPrompt.text);
  const ctrlPolicyAllows =
    !forcedAuto && playback.ctrl_fast_forward === "allow";
  const fastForwardRequested =
    ctrlHeld && ctrlPolicyAllows && settings.skip_mode !== "disabled";
  const fastForwardDialogueAllowed =
    textPrompt !== null &&
    (settings.skip_mode === "all" ||
      (settings.skip_mode === "read_only" && textPrompt.is_read));
  const fastForwardActive =
    phase === "playing" &&
    panel === "none" &&
    fastForwardRequested &&
    update !== null &&
    canFastForwardPrompt(
      playback,
      settings.skip_mode,
      update.snapshot.prompt,
    ) &&
    (activeTimelineCue === undefined ||
      settings.skip_mode === "all" ||
      (settings.skip_mode === "read_only" && activeTimelineCue.is_seen));
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

  const handleRevealComplete = useCallback((promptId: string): void => {
    setCompletedPromptId(promptId);
  }, []);

  useEffect(() => {
    if (
      phase !== "playing" ||
      panel !== "none" ||
      busy ||
      runtimeLocked ||
      textPrompt === null
    ) {
      return;
    }

    let timer = 0;
    if (completedPromptId !== textPrompt.prompt_id) return;
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
      if (longText === null) dialogueRef.current?.complete();
      else longTextRef.current?.complete();
      timer = window.setTimeout(() => advance("fast_forward"), 50);
    } else if (normalAuto && completedPromptId === textPrompt.prompt_id) {
      timer = window.setTimeout(
        () => advance("auto"),
        autoReadingDelay(textPrompt.text),
      );
    }
    return () => window.clearTimeout(timer);
  }, [
    advance,
    busy,
    completedPromptId,
    textPrompt,
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
      } else if (event.key === "Escape" && phase === "story_flow") {
        event.preventDefault();
        setPhase("title");
        phaseRef.current = "title";
      }
    };
    window.addEventListener("keydown", closePanel);
    return () => window.removeEventListener("keydown", closePanel);
  }, [panel, phase]);

  return (
    <main className="app-shell">
      <section className="game-viewport" style={viewportStyle}>
        <SceneCanvas
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
          uiMotionHost={uiMotionHost}
          visible={phase === "playing"}
        />

        {phase === "booting" && (
          <div className="boot-screen">
            <div className="loader" />
            <p>正在校验内容与启动运行时…</p>
          </div>
        )}

        {phase === "title" && (
          <div className="title-screen">
            <div className="title-card">
              <p className="eyebrow">A MATHEMATICAL VISUAL NOVEL</p>
              <h1>VECTSPACE</h1>
              <p className="title-formula">
                <MarkupText source="$V=U\oplus W$" />
              </p>
              <div className="title-actions">
                <button
                  disabled={update === null || busy}
                  onClick={startNewGame}
                  type="button"
                >
                  开始演示
                </button>
                <button
                  disabled={!autoSlot?.exists || busy}
                  onClick={() => load("auto")}
                  type="button"
                >
                  继续
                </button>
                <button onClick={() => setPanel("saves")} type="button">
                  读取存档
                </button>
                <button onClick={() => setPanel("settings")} type="button">
                  设置
                </button>
                <button
                  disabled={!storyFlowAvailable}
                  onClick={openStoryFlow}
                  type="button"
                >
                  剧情流程
                </button>
              </div>
              <small>内容版本 {contentVersion || "未载入"}</small>
            </div>
          </div>
        )}

        {phase === "story_flow" && storyFlow !== null && (
          <StoryFlowPage flow={storyFlow} onClose={closeStoryFlow} />
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
              <button onClick={() => setPanel("saves")} type="button">
                存档 / 读档
              </button>
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

            {renderedDialoguePage !== null && (
              <DialogueBox
                defaultCps={revealDefaultCps}
                dialogueBoxUrl={assets["gui.dialogue_box"] ?? ""}
                disabled={busy || runtimeLocked}
                initialCps={revealCps}
                key={`${renderedDialoguePage.page_id}:${dialogue?.prompt_id ?? `retained:${update.snapshot.revision}`}`}
                motionHost={uiMotionHost}
                nameBoxUrl={assets["gui.name_box"] ?? ""}
                onTypingChange={handleTypingChange}
                onRevealComplete={handleRevealComplete}
                page={renderedDialoguePage}
                prompt={dialogue}
                revealAnimation={revealAnimation}
                fontReady={fontReady}
                ref={dialogueRef}
                revealImmediately={
                  dialogue === null || !hasTextRevealCue
                }
                visible={update.snapshot.world.dialogue_ui_visible}
              />
            )}

            {longText !== null && longTextPage !== null && (
              <LongTextPanel
                defaultCps={revealDefaultCps}
                disabled={busy || runtimeLocked}
                fastForward={fastForwardActive}
                initialCps={revealCps}
                key={longTextPage.document_id}
                onRevealComplete={handleRevealComplete}
                onTypingChange={handleTypingChange}
                page={longTextPage}
                paperUrl={
                  longTextPage.paper === null ||
                  longTextPage.paper === undefined
                    ? undefined
                    : (assets[longTextPage.paper] ?? null)
                }
                prompt={longText}
                revealAnimation={revealAnimation}
                designScale={viewportMetrics.scale}
                fontReady={fontReady}
                ref={longTextRef}
                revealImmediately={!hasTextRevealCue}
              />
            )}

            {choice !== null && (
              <ChoicePanel
                disabled={busy || runtimeLocked}
                onChoose={choose}
                prompt={choice}
              />
            )}

            {update.snapshot.prompt.kind === "end" && (
              <div className="end-card">
                <p>演示场景结束</p>
                <button onClick={returnToTitle} type="button">
                  返回标题
                </button>
              </div>
            )}

            {runtimeLocked && <div className="runtime-lock">表现同步中…</div>}
          </>
        )}

        {panel === "saves" && (
          <SavePanel
            canSave={phase === "playing" && !runtimeLocked}
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

interface ChoicePanelProps {
  prompt: ChoicePrompt;
  disabled: boolean;
  onChoose(choiceId: string): void;
}

function ChoicePanel({
  prompt,
  disabled,
  onChoose,
}: ChoicePanelProps): ReactElement {
  return (
    <div className="choice-panel">
      {prompt.choices.map((choice) => (
        <button
          disabled={disabled || !choice.enabled}
          key={choice.id}
          onClick={() => onChoose(choice.id)}
          type="button"
        >
          <MarkupText source={choice.label} />
        </button>
      ))}
    </div>
  );
}

interface SavePanelProps {
  slots: SaveSlotSummary[];
  canSave: boolean;
  onSave(slot: string): void;
  onLoad(slot: string): void;
  onClose(): void;
}

function SavePanel({
  slots,
  canSave,
  onSave,
  onLoad,
  onClose,
}: SavePanelProps): ReactElement {
  return (
    <div className="modal-backdrop">
      <section className="modal-panel save-panel" aria-label="存档">
        <header>
          <div>
            <p className="eyebrow">SNAPSHOT ONLY</p>
            <h2>存档与读档</h2>
          </div>
          <button onClick={onClose} type="button">
            关闭
          </button>
        </header>
        <div className="slot-grid">
          {slots.map((slot) => (
            <article className="save-slot" key={slot.slot}>
              {slot.thumbnail_data_url !== null ? (
                <img alt="场景缩略图" src={slot.thumbnail_data_url} />
              ) : (
                <div className="empty-thumbnail">NO DATA</div>
              )}
              <div className="slot-copy">
                <strong>
                  {slot.slot === "auto" ? "自动存档" : `手动槽 ${slot.slot}`}
                </strong>
                <span>{formatTimestamp(slot.saved_at_unix_ms)}</span>
                <p>{slot.prompt_preview ?? "空存档"}</p>
              </div>
              <div className="slot-actions">
                {slot.slot !== "auto" && (
                  <button
                    disabled={!canSave}
                    onClick={() => onSave(slot.slot)}
                    type="button"
                  >
                    保存
                  </button>
                )}
                <button
                  disabled={!slot.exists}
                  onClick={() => onLoad(slot.slot)}
                  type="button"
                >
                  读取
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

interface SettingsPanelProps {
  settings: Settings;
  onChange(settings: Settings): void;
  onSave(): void;
  onClose(): void;
}

function SettingsPanel({
  settings,
  onChange,
  onSave,
  onClose,
}: SettingsPanelProps): ReactElement {
  const [animationPreviewRevision, setAnimationPreviewRevision] = useState(0);
  const [animationPreviewVisibleCount, setAnimationPreviewVisibleCount] =
    useState(0);
  const animationPreviewSource = "示例：$A \\cong B$，文字";
  useEffect(() => {
    const units = parseMarkup(animationPreviewSource);
    const schedule = buildRevealSchedule(
      units,
      settings.text_speed_cps,
      settings.text_speed_cps,
    );
    let frame = 0;
    const startedAt = performance.now();
    const tick = (now: number): void => {
      const elapsed = now - startedAt;
      let next = 0;
      while (
        next < schedule.length &&
        (schedule[next] ?? Number.POSITIVE_INFINITY) <= elapsed
      ) {
        next += 1;
      }
      setAnimationPreviewVisibleCount(next);
      if (next < schedule.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(() => {
      setAnimationPreviewVisibleCount(0);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    animationPreviewRevision,
    settings.text_reveal_animation,
    settings.text_speed_cps,
  ]);
  const rows: {
    key:
      | "master_volume"
      | "bgm_volume"
      | "sfx_volume"
      | "video_volume"
      | "text_speed_cps";
    label: string;
    min: number;
    max: number;
    step: number;
  }[] = [
    { key: "master_volume", label: "主音量", min: 0, max: 1, step: 0.01 },
    { key: "bgm_volume", label: "BGM", min: 0, max: 1, step: 0.01 },
    { key: "sfx_volume", label: "音效", min: 0, max: 1, step: 0.01 },
    { key: "video_volume", label: "视频", min: 0, max: 1, step: 0.01 },
    { key: "text_speed_cps", label: "文字速度", min: 5, max: 80, step: 1 },
  ];
  return (
    <div className="modal-backdrop">
      <section className="modal-panel settings-panel" aria-label="设置">
        <header>
          <div>
            <p className="eyebrow">LOCAL SETTINGS</p>
            <h2>设置</h2>
          </div>
          <button onClick={onClose} type="button">
            关闭
          </button>
        </header>
        {rows.map((row) => (
          <label className="setting-row" key={row.key}>
            <span>{row.label}</span>
            <input
              max={row.max}
              min={row.min}
              onChange={(event) =>
                onChange({
                  ...settings,
                  [row.key]: Number(event.currentTarget.value),
                })
              }
              step={row.step}
              type="range"
              value={settings[row.key]}
            />
            <output>{formatSetting(settings[row.key], row.key)}</output>
          </label>
        ))}
        <label className="setting-row">
          <span>文字动画</span>
          <select
            onChange={(event) =>
              onChange({
                ...settings,
                text_reveal_animation: event.currentTarget
                  .value as TextRevealAnimation,
              })
            }
            value={settings.text_reveal_animation}
          >
            <option value="line_sweep">逐行横向渐显</option>
            <option value="typewriter">逐字 / 公式渐显</option>
            <option value="drop_fade">下落渐显</option>
          </select>
          <output />
        </label>
        <div
          className="text-animation-preview"
          key={`${animationPreviewRevision}:${settings.text_reveal_animation}`}
        >
          <MarkupText
            animateMath
            revealAnimation={settings.text_reveal_animation}
            source={animationPreviewSource}
            visibleCount={animationPreviewVisibleCount}
          />
          <button
            onClick={() =>
              setAnimationPreviewRevision((revision) => revision + 1)
            }
            type="button"
          >
            重播示例
          </button>
        </div>
        <label className="setting-row">
          <span>Ctrl 快进</span>
          <select
            onChange={(event) =>
              onChange({
                ...settings,
                skip_mode: event.currentTarget.value as Settings["skip_mode"],
              })
            }
            value={settings.skip_mode}
          >
            <option value="disabled">关闭快进</option>
            <option value="read_only">快进已读内容</option>
            <option value="all">全部快进</option>
          </select>
          <output />
        </label>
        <button className="primary-action" onClick={onSave} type="button">
          保存设置
        </button>
      </section>
    </div>
  );
}

function textRevealSpeed(
  update: RuntimeUpdate | null,
  prompt: DialoguePrompt | LongTextPrompt | null,
): number | null | undefined {
  if (update === null || prompt === null) {
    return undefined;
  }
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

function getInitialAppState(): Promise<InitialAppState> {
  initialAppStatePromise ??= loadInitialAppState().catch((reason: unknown) => {
    initialAppStatePromise = null;
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
  return initialAppStatePromise;
}

async function loadInitialAppState(attempt = 1): Promise<InitialAppState> {
  try {
    return await withStartupTimeout(loadInitialAppStateAttempt(), 6_000);
  } catch (reason) {
    if (attempt >= 3) {
      throw reason;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, attempt * 250);
    });
    return loadInitialAppState(attempt + 1);
  }
}

async function loadInitialAppStateAttempt(): Promise<InitialAppState> {
  const [bootstrap, settings, slots] = await Promise.all([
    engineApi.bootstrap(),
    engineApi.loadSettings(),
    engineApi.listSaveSlots(),
  ]);
  const resolved = await engineApi.resolveAssets(bootstrap.asset_ids);
  return {
    bootstrap,
    settings,
    slots,
    assets: resolvedAssetsToUrls(resolved),
  };
}

function withStartupTimeout<T>(
  promise: Promise<T>,
  durationMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("连接 Rust 运行时超时，正在重试")),
      durationMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        window.clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function formatTimestamp(value: number | null): string {
  return value === null
    ? "—"
    : new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatSetting(
  value: number,
  key:
    | "master_volume"
    | "bgm_volume"
    | "sfx_volume"
    | "video_volume"
    | "text_speed_cps",
): string {
  return key === "text_speed_cps"
    ? `${Math.round(value)} cps`
    : `${Math.round(value * 100)}%`;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, input, select, textarea, a, label, [contenteditable='true'], [data-block-story-advance]",
    ) !== null
  );
}
