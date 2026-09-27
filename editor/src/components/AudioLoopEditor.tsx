/**
 * Per-node BGM/ambience waveform and loop-point editor.
 *
 * Rendered by the node inspector for `start` actions only.  It owns no runtime
 * audio: the waveform is a bounded one-off decode and the audition transport is
 * a private `<audio>` element that never touches the shared `AudioManager`
 * buses or the timeline snapshot.  Sound is only produced by an explicit user
 * Play / loop-audition action, and the element is paused and released whenever
 * the node or asset changes and on unmount.
 *
 * Marker edits commit exactly once on pointer-up (with a local drag draft), so
 * a drag is a single undo entry.  Numeric commits use the same finite,
 * non-negative, integer policy and never snap to pixels or a coarse step.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { assetUrl } from "../api";
import {
  defaultLoopBounds,
  markerMs,
  msToRatio,
  parseMetadataDurationMs,
  ratioToMs,
  resolveMarkerMs,
  sameLoopValues,
  toIntegerMs,
  withMarker,
  type AudioLoopMarker,
  type AudioLoopValues,
} from "../audioLoop";
import {
  decodeWaveform,
  describeError,
  type WaveformPeaks,
} from "../audioWaveform";
import type { EditorAsset } from "../types";
import { Field } from "./Fields";
import { isComposing } from "../ui/keyboard";
import { usePendingCommit } from "../ui/pendingCommits";

/**
 * How early the seam audition rewinds *before* `loop_end_ms`.
 *
 * This is an early threshold, not an accuracy claim: `timeupdate` fires at a
 * browser-defined cadence that can be far coarser than 25 ms, so playback may
 * overshoot the loop end and the wrap is never sample-accurate.
 */
const SEAM_TOLERANCE_SECONDS = 0.025;

/**
 * Quick-seam lead-in: the seam audition starts this far before `loop_end_ms`
 * (never before `loop_start_ms`), so the first pass crosses the seam almost
 * immediately instead of replaying the whole loop.
 */
const SEAM_LEAD_MS = 1500;

export interface AudioLoopEditPatch {
  loop_end_ms: number | null;
  loop_start_ms: number | null;
  start_ms: number;
}

export interface AudioLoopEditorProps {
  /** Registered asset for the node's `asset` id, when one exists. */
  asset: EditorAsset | null | undefined;
  /** Human label for the owning node type ("BGM" / "环境声"). */
  label: string;
  loopEndMs: number | null;
  loopStartMs: number | null;
  onChange(patch: AudioLoopEditPatch): void;
  onError?(message: string): void;
  startMs: number;
  volume?: number;
  /** Test seam: replace the bounded browser decoder. */
  decode?: (url: string, signal: AbortSignal) => Promise<WaveformPeaks>;
}

type WaveformState =
  | { status: "idle" | "loading" }
  | { durationMs: number; peaks: number[]; status: "ready" }
  | { message: string; status: "unavailable" };

type PlaybackState = "paused" | "playing" | "stopped";

/**
 * One-shot versus loop audition.  It is fixed when the author starts the
 * transport: a later loop-point edit may retarget a running loop audition, but
 * it can never turn a one-shot audition into a loop (or the other way around).
 */
type TransportMode = "loop" | "none" | "oneshot";

/**
 * The waveform decode lives outside the keyed session so that editing a loop
 * point does not throw away already-decoded peaks.  The session itself is keyed
 * by the selected asset only: the media listeners read the committed authored
 * bounds through a ref, so a marker edit — local or an undo/redo — keeps the
 * same `<audio>` element, its cursor and its playback phase instead of
 * remounting the transport.  Remounting instead of resetting state in an effect
 * keeps this free of render-time ref writes and effect-body state updates, and
 * an asset or node change still tears the private transport down.
 */
export function AudioLoopEditor(props: AudioLoopEditorProps): ReactElement {
  const url =
    props.asset === null || props.asset === undefined
      ? null
      : assetUrl(props.asset.absolute_path);
  const waveform = useWaveformLoad(
    props.decode,
    url,
    props.asset?.metadata ?? null,
  );
  const sessionKey = props.asset?.id ?? "none";
  return (
    <AudioLoopSession
      {...props}
      key={sessionKey}
      url={url}
      waveform={waveform}
    />
  );
}

/**
 * Bounded, abortable waveform decode.  The result is keyed by URL so a stale
 * decode after a node/asset change can never update the current node, and the
 * loader identity follows only the injected test seam.
 */
function useWaveformLoad(
  decode: AudioLoopEditorProps["decode"],
  url: string | null,
  metadata: EditorAsset["metadata"] | null,
): WaveformState {
  const [load, setLoad] = useState<{
    state: WaveformState;
    url: string;
  } | null>(null);
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    const request =
      decode !== undefined
        ? decode(url, controller.signal)
        : decodeWaveform(url, {
            knownChannels: metadata?.channels ?? null,
            knownDurationMs: parseMetadataDurationMs(
              metadata?.duration_ms ?? null,
            ),
            knownSampleRate: metadata?.sample_rate ?? null,
            signal: controller.signal,
          });
    void request.then(
      (result) => {
        if (controller.signal.aborted) return;
        setLoad({
          state: {
            durationMs: result.durationMs,
            peaks: result.peaks,
            status: "ready",
          },
          url,
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({
          state: { message: describeError(error), status: "unavailable" },
          url,
        });
      },
    );
    return () => controller.abort();
  }, [decode, metadata, url]);
  if (url === null) return { status: "idle" };
  return load !== null && load.url === url ? load.state : { status: "loading" };
}

function AudioLoopSession({
  asset,
  label,
  loopEndMs,
  loopStartMs,
  onChange,
  onError,
  startMs,
  url,
  volume = 1,
  waveform,
}: AudioLoopEditorProps & {
  url: string | null;
  waveform: WaveformState;
}): ReactElement {
  const metadataDurationMs = parseMetadataDurationMs(
    asset?.metadata?.duration_ms ?? null,
  );
  const [draft, setDraft] = useState<AudioLoopValues | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>("stopped");
  const [auditionError, setAuditionError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState<number | null>(null);
  const [transport, setTransport] = useState<TransportMode>("none");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<AudioLoopValues | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  /**
   * Generation of the current play attempt.  Starting bumps it, and so does any
   * deliberate pause/stop, source change or unmount, so a `play()` rejection
   * whose generation is stale is a cancelled attempt rather than a failure.
   */
  const playAttemptRef = useRef(0);
  /** Start position queued until the element reaches `HAVE_METADATA`. */
  const pendingSeekRef = useRef<number | null>(null);
  /**
   * Latest committed bounds, mode and error sink, read by media listeners.
   * `armed` is the authoritative "media events may still drive the transport"
   * flag: it is cleared *synchronously before* `pause()` on Pause/Stop, on a
   * source change, on unmount and on a genuine `play()` failure, so a queued
   * `timeupdate`/`ended` can never rewind, restart or revive the audition.
   */
  const authoredRef = useRef<AudioLoopValues>({
    loopEndMs,
    loopStartMs,
    startMs,
  });
  const transportRef = useRef<{ armed: boolean; mode: TransportMode }>({
    armed: false,
    mode: "none",
  });
  const onErrorRef = useRef(onError);

  useEffect(() => {
    authoredRef.current = { loopEndMs, loopStartMs, startMs };
    // Mirror the rendered mode without touching `armed`, which is only ever
    // changed imperatively by the transport handlers.
    transportRef.current = { ...transportRef.current, mode: transport };
    onErrorRef.current = onError;
  }, [loopEndMs, loopStartMs, onError, startMs, transport]);

  const authored: AudioLoopValues = {
    loopEndMs,
    loopStartMs,
    startMs,
  };
  const values = draft ?? authored;
  const durationMs =
    waveform.status === "ready" ? waveform.durationMs : metadataDurationMs;
  const canDrag = url !== null && durationMs !== null && durationMs > 0;
  const loopEnabled = values.loopStartMs !== null && values.loopEndMs !== null;
  const authoredLoopEnabled = loopStartMs !== null && loopEndMs !== null;

  const commit = useCallback(
    (next: AudioLoopValues): void => {
      const current: AudioLoopValues = { loopEndMs, loopStartMs, startMs };
      if (sameLoopValues(next, current)) return;
      onChange({
        loop_end_ms: next.loopEndMs,
        loop_start_ms: next.loopStartMs,
        start_ms: next.startMs,
      });
    },
    [loopEndMs, loopStartMs, onChange, startMs],
  );

  // --- Private audition transport ------------------------------------------
  /**
   * The media source is owned imperatively, never by React.  StrictMode runs
   * every mount effect as setup -> cleanup -> setup; a cleanup that removed a
   * React-owned `src` attribute would leave the element without any media,
   * because React only re-applies props that changed.  Since this effect's whole
   * body re-runs after the synthetic cleanup, assigning the URL here restores
   * the source, while a real unmount or asset switch still pauses and releases
   * the old media and invalidates every in-flight `play()`.
   */
  useEffect(() => {
    const element = audioRef.current;
    if (element === null) return;
    if (url !== null) element.src = url;
    return () => {
      playAttemptRef.current += 1;
      pendingSeekRef.current = null;
      transportRef.current = { armed: false, mode: "none" };
      element.pause();
      if (url !== null) {
        element.removeAttribute("src");
        element.load();
      }
    };
  }, [url]);

  // Unmount: no pointer listener survives the inspector.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    const element = audioRef.current;
    if (element === null) return;
    element.volume = Math.min(Math.max(volume, 0), 1);
  }, [volume]);

  /**
   * Apply a playback position.  Right after the source is assigned the element
   * can still be short of `HAVE_METADATA`, so the seek is queued and replayed
   * from `loadedmetadata`; the real `play()` call is never blocked waiting for
   * metadata, it simply starts from the beginning until the queued seek lands.
   */
  const applyPosition = useCallback(
    (element: HTMLAudioElement, positionMs: number): void => {
      if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
        element.currentTime = positionMs / 1000;
        return;
      }
      pendingSeekRef.current = positionMs;
    },
    [],
  );

  const seekTo = useCallback(
    (rawMs: number): void => {
      const ms = toIntegerMs(rawMs);
      if (ms === null) return;
      setPositionMs(ms);
      const element = audioRef.current;
      if (element !== null) applyPosition(element, ms);
    },
    [applyPosition],
  );

  const requestPlay = useCallback((element: HTMLAudioElement): void => {
    const attempt = playAttemptRef.current;
    void Promise.resolve(element.play()).catch((reason: unknown) => {
      // A rejection whose generation is stale was superseded by a deliberate
      // Pause/Stop, a newer audition, an asset change or an unmount: that is a
      // cancellation and must not touch the current transport or surface an
      // error.  A rejection of the *current* attempt is a real failure — even a
      // current AbortError (for example a source the engine aborted on its own)
      // — so it is reported and disarms the transport.
      if (attempt !== playAttemptRef.current) return;
      transportRef.current = { ...transportRef.current, armed: false };
      setPlayback("paused");
      const message = `无法开始试听：${describeError(reason)}`;
      setAuditionError(message);
      onErrorRef.current?.(message);
    });
  }, []);

  /**
   * Media listeners are installed once and read the latest committed bounds,
   * mode and callbacks through refs: a marker edit, an undo/redo or any other
   * re-render must never detach them, reset the cursor or restart the element.
   * Every handler bows out immediately when the transport is disarmed, so a
   * queued event from before a Pause/Stop cannot seek, rewind or replay.
   */
  useEffect(() => {
    const element = audioRef.current;
    if (element === null) return;
    const onLoadedMetadata = (): void => {
      const pending = pendingSeekRef.current;
      if (pending === null) return;
      pendingSeekRef.current = null;
      element.currentTime = pending / 1000;
    };
    const onTimeUpdate = (): void => {
      if (!transportRef.current.armed) return;
      const position = toIntegerMs(element.currentTime * 1000);
      if (position !== null) setPositionMs(position);
      if (transportRef.current.mode !== "loop") return;
      const bounds = authoredRef.current;
      if (bounds.loopStartMs === null || bounds.loopEndMs === null) return;
      // The wrap reads the *current* committed bounds, so a local edit or an
      // undo/redo takes effect at the next boundary check.  A cursor left past
      // the new end rewinds here; a range entirely ahead of the cursor is never
      // jumped to, it just plays its gap once and wraps afterwards.
      if (
        element.currentTime >=
        bounds.loopEndMs / 1000 - SEAM_TOLERANCE_SECONDS
      )
        element.currentTime = bounds.loopStartMs / 1000;
    };
    const onEnded = (): void => {
      if (!transportRef.current.armed) return;
      const bounds = authoredRef.current;
      if (
        transportRef.current.mode === "loop" &&
        bounds.loopStartMs !== null &&
        bounds.loopEndMs !== null
      ) {
        element.currentTime = bounds.loopStartMs / 1000;
        requestPlay(element);
        return;
      }
      // A one-shot audition (or a whole-file loop whose EOF still fired) is
      // over. Clearing the cursor makes the next audition replay from the
      // authored start instead of starting at EOF and ending immediately.
      transportRef.current = { armed: false, mode: "none" };
      setTransport("none");
      setPlayback("stopped");
      setPositionMs(null);
    };
    const onError = (): void => setMediaError("音频无法加载，试听不可用");
    element.addEventListener("ended", onEnded);
    element.addEventListener("error", onError);
    element.addEventListener("loadedmetadata", onLoadedMetadata);
    element.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", onError);
      element.removeEventListener("loadedmetadata", onLoadedMetadata);
      element.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [requestPlay]);

  /**
   * A loop audition whose custom bounds are removed keeps the same element and
   * simply falls back to the element's native whole-file loop; disabling the
   * bounds never restarts playback.  A one-shot audition stays one-shot even if
   * bounds appear later.
   */
  useEffect(() => {
    const element = audioRef.current;
    if (element === null) return;
    element.loop = transport === "loop" && !authoredLoopEnabled;
  }, [authoredLoopEnabled, transport]);

  const beginAudition = (fromMs: number, mode: TransportMode): void => {
    const element = audioRef.current;
    if (element === null || url === null) {
      setAuditionError("未选择音频素材，无法试听");
      return;
    }
    playAttemptRef.current += 1;
    pendingSeekRef.current = null;
    transportRef.current = { armed: true, mode };
    // Start from the mode's own loop setting rather than forcing `false`: a
    // resumed loop audition whose custom bounds were removed while paused must
    // fall straight back to the element's native whole-file loop.
    element.loop = mode === "loop" && !authoredLoopEnabled;
    setTransport(mode);
    setAuditionError(null);
    setPlayback("playing");
    setPositionMs(fromMs);
    applyPosition(element, fromMs);
    requestPlay(element);
  };

  /**
   * Play / Resume.  Pause keeps the mode the author selected, so resuming a
   * paused loop audition keeps looping around the current committed bounds; a
   * stopped transport (or a fresh mount) starts a plain one-shot instead.
   */
  const playAudition = (): void => {
    const mode = transportRef.current.mode === "loop" ? "loop" : "oneshot";
    beginAudition(positionMs ?? values.startMs, mode);
  };

  const pauseAudition = (): void => {
    // Disarm and supersede *before* pausing: the pending play() rejection is a
    // cancellation, and an already-queued timeupdate/ended must not rewind or
    // restart a transport the author just paused.  The mode is deliberately
    // kept so Resume continues the same loop/one-shot audition.
    playAttemptRef.current += 1;
    transportRef.current = { ...transportRef.current, armed: false };
    audioRef.current?.pause();
    setPlayback("paused");
  };

  const stopAudition = (): void => {
    // A full reset before pausing: no mode, no armed flag, no queued metadata
    // seek and no cursor, so nothing that arrives later can revive playback.
    playAttemptRef.current += 1;
    transportRef.current = { armed: false, mode: "none" };
    pendingSeekRef.current = null;
    audioRef.current?.pause();
    setTransport("none");
    setPlayback("stopped");
    setPositionMs(null);
  };

  const loopAuditionBounds = (): { endMs: number; startMs: number } | null => {
    const seamStart = values.loopStartMs;
    const seamEnd = values.loopEndMs;
    if (seamStart === null || seamEnd === null) {
      setAuditionError("需要同时设置循环起点与终点才能试听循环段");
      return null;
    }
    return { endMs: seamEnd, startMs: seamStart };
  };

  /** Whole-loop audition: hear the full custom loop from its start. */
  const startLoopAudition = (): void => {
    const seam = loopAuditionBounds();
    if (seam === null) return;
    beginAudition(seam.startMs, "loop");
  };

  /**
   * Quick seam audition: start shortly before the loop end so the first seam
   * crossing (wrap back to the loop start) is heard immediately, then keep
   * wrapping.  For a loop shorter than the lead-in it begins at the loop start.
   * The lead-in belongs to this explicit action only — editing the loop points
   * afterwards never re-applies it.
   */
  const startSeamAudition = (): void => {
    const seam = loopAuditionBounds();
    if (seam === null) return;
    beginAudition(Math.max(seam.startMs, seam.endMs - SEAM_LEAD_MS), "loop");
  };

  // --- Marker editing -------------------------------------------------------
  const pointerToMs = (clientX: number): number | null => {
    const track = trackRef.current;
    if (track === null || durationMs === null || durationMs <= 0) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return ratioToMs((clientX - rect.left) / rect.width, durationMs);
  };

  const onTrackPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const ms = pointerToMs(event.clientX);
    if (ms === null) return;
    // Click-to-position only seeks; it never starts playback.
    seekTo(ms);
  };

  const beginDrag =
    (marker: AudioLoopMarker) =>
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!canDrag) return;
      event.preventDefault();
      event.stopPropagation();
      const startValues = values;
      const move = (moveEvent: PointerEvent): void => {
        const raw = pointerToMs(moveEvent.clientX);
        if (raw === null) return;
        const resolved = resolveMarkerMs(marker, raw, startValues, durationMs);
        if (resolved === null) return;
        const next = withMarker(startValues, marker, resolved);
        draftRef.current = next;
        setDraft(next);
      };
      const finish = (): void => {
        cleanup();
        const pending = draftRef.current;
        draftRef.current = null;
        setDraft(null);
        if (pending !== null) commit(pending);
      };
      const cancel = (): void => {
        cleanup();
        draftRef.current = null;
        setDraft(null);
      };
      const cleanup = (): void => {
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        dragCleanupRef.current = null;
      };
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      dragCleanupRef.current = cleanup;
      // Seed the draft so a click without movement already shows the marker
      // under the pointer; the single commit still happens on pointer-up.
      move(event.nativeEvent);
    };

  const onHandleKeyDown =
    (marker: AudioLoopMarker) =>
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (!canDrag) return;
      const current = markerMs(values, marker);
      if (current === null) return;
      const step = event.shiftKey ? 1 : 10;
      let raw: number | null = null;
      if (event.key === "ArrowLeft") raw = current - step;
      else if (event.key === "ArrowRight") raw = current + step;
      else if (event.key === "Home") raw = 0;
      else if (event.key === "End") raw = durationMs;
      else return;
      event.preventDefault();
      const resolved = resolveMarkerMs(marker, raw, values, durationMs);
      if (resolved === null) return;
      commit(withMarker(values, marker, resolved));
    };

  const commitNumeric = (
    marker: AudioLoopMarker,
    raw: number,
  ): number | null => {
    const resolved = resolveMarkerMs(marker, raw, values, durationMs);
    if (resolved === null) return null;
    commit(withMarker(values, marker, resolved));
    return resolved;
  };

  const toggleLoop = (enabled: boolean): void => {
    if (enabled) {
      const bounds = defaultLoopBounds(durationMs, values.startMs);
      commit({ ...values, ...bounds });
    } else {
      commit({ ...values, loopEndMs: null, loopStartMs: null });
    }
  };

  // --- Render ---------------------------------------------------------------
  const peaks = waveform.status === "ready" ? waveform.peaks : null;
  const statusText =
    url === null
      ? "未选择素材"
      : waveform.status === "loading"
        ? "波形加载中…"
        : waveform.status === "ready"
          ? `素材时长 ${(waveform.durationMs / 1000).toFixed(2)} s`
          : waveform.status === "unavailable"
            ? "波形不可用"
            : "素材时长未知";
  const fallbackText =
    waveform.status === "unavailable"
      ? waveform.message
      : url === null
        ? "选择素材后可查看波形并试听。"
        : canDrag
          ? null
          : "素材时长未知，无法拖动标记；仍可精确填写毫秒数值。";

  // Accurate transport label: a cursor positioned away from the authored
  // start is a resume, not a restart from `start_ms`.
  const playLabel =
    playback === "playing"
      ? "暂停试听"
      : positionMs !== null && positionMs !== values.startMs
        ? `继续试听（${positionMs} ms）`
        : "试听（从起播点）";

  const percent = (ms: number | null): string => {
    if (ms === null) return "0%";
    const ratio = msToRatio(ms, durationMs);
    return `${((ratio ?? 0) * 100).toFixed(3)}%`;
  };

  return (
    <div className="audio-loop-editor">
      <div className="audio-loop-head">
        <strong>{label} 波形与循环点</strong>
        <small role="status">{statusText}</small>
      </div>
      <div
        aria-label={`${label} 波形`}
        className="audio-loop-track"
        data-audio-loop-track="true"
        onPointerDown={onTrackPointerDown}
        ref={trackRef}
        role="group"
      >
        <Waveform peaks={peaks} />
        {loopEnabled && canDrag && (
          <span
            aria-hidden="true"
            className="audio-loop-region"
            style={{
              left: percent(values.loopStartMs),
              right: `calc(100% - ${percent(values.loopEndMs)})`,
            }}
          />
        )}
        {positionMs !== null && canDrag && (
          <span
            aria-hidden="true"
            className="audio-loop-playhead"
            style={{ left: percent(positionMs) }}
          />
        )}
        {canDrag && (
          <>
            <MarkerHandle
              active={draft !== null}
              label={`${label} 起播标记`}
              marker="start"
              max={durationMs ?? 0}
              ms={values.startMs}
              onKeyDown={onHandleKeyDown}
              onPointerDown={beginDrag}
              percent={percent(values.startMs)}
            />
            {loopEnabled && (
              <>
                <MarkerHandle
                  label={`${label} 循环起点标记`}
                  marker="loop_start"
                  max={durationMs ?? 0}
                  ms={values.loopStartMs ?? 0}
                  onKeyDown={onHandleKeyDown}
                  onPointerDown={beginDrag}
                  percent={percent(values.loopStartMs)}
                />
                <MarkerHandle
                  label={`${label} 循环终点标记`}
                  marker="loop_end"
                  max={durationMs ?? 0}
                  ms={values.loopEndMs ?? 0}
                  onKeyDown={onHandleKeyDown}
                  onPointerDown={beginDrag}
                  percent={percent(values.loopEndMs)}
                />
              </>
            )}
          </>
        )}
        {fallbackText !== null && (
          <span className="audio-loop-fallback">{fallbackText}</span>
        )}
      </div>

      <div className="audio-loop-transport">
        <button
          onClick={playback === "playing" ? pauseAudition : playAudition}
          type="button"
        >
          {playLabel}
        </button>
        <button
          disabled={!loopEnabled || url === null}
          onClick={startLoopAudition}
          type="button"
        >
          整段循环试听
        </button>
        <button
          disabled={!loopEnabled || url === null}
          onClick={startSeamAudition}
          type="button"
        >
          接缝试听
        </button>
        <button disabled={url === null} onClick={stopAudition} type="button">
          停止
        </button>
        <small className="audio-loop-position">
          {positionMs === null ? "—" : `${positionMs} ms`}
        </small>
      </div>

      {mediaError !== null && (
        <p className="audio-loop-error" role="alert">
          {mediaError}
        </p>
      )}
      {auditionError !== null && (
        <p className="audio-loop-error" role="alert">
          {auditionError}
        </p>
      )}

      <p className="audio-loop-hint">
        同一素材再次以 start 更新时保留当前播放相位，只更新循环点与音量； 「起播
        ms」仅在元素首次开始播放时生效。试听会跟随循环点的修改，
        不会因为改动边界而重新开始。
      </p>

      <div className="audio-loop-fields">
        <MsField
          label="起播 ms"
          onCommit={(raw) => commitNumeric("start", raw)}
          value={values.startMs}
        />
        <label className="boolean-field audio-loop-toggle">
          <input
            checked={loopEnabled}
            onChange={(event) => toggleLoop(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>自定义循环段</span>
        </label>
        {loopEnabled && (
          <div className="field-grid">
            <MsField
              label="循环起点 ms"
              onCommit={(raw) => commitNumeric("loop_start", raw)}
              value={values.loopStartMs ?? 0}
            />
            <MsField
              label="循环终点 ms"
              onCommit={(raw) => commitNumeric("loop_end", raw)}
              value={values.loopEndMs ?? 0}
            />
          </div>
        )}
      </div>

      {/* The source is assigned imperatively (see the source effect) so React
          StrictMode's mount cleanup cannot leave the element without media. */}
      <audio
        className="audio-loop-audio"
        hidden
        preload="metadata"
        ref={audioRef}
      />
    </div>
  );
}

function MarkerHandle({
  active = false,
  label,
  marker,
  max,
  ms,
  onKeyDown,
  onPointerDown,
  percent,
}: {
  active?: boolean;
  label: string;
  marker: AudioLoopMarker;
  max: number;
  ms: number;
  onKeyDown(
    marker: AudioLoopMarker,
  ): (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown(
    marker: AudioLoopMarker,
  ): (event: ReactPointerEvent<HTMLButtonElement>) => void;
  percent: string;
}): ReactElement {
  // Authored values are preserved exactly (the numeric field shows them), but
  // the slider attributes must stay inside [min, max] for assistive tech even
  // when an authored marker points past the media length.
  const maxValue = Math.max(max, 0);
  const clamped = Math.min(Math.max(ms, 0), maxValue);
  const valueText =
    clamped === ms
      ? `${ms} ms`
      : `已保存 ${ms} ms，超出素材时长，按 ${clamped} ms 显示`;
  return (
    <button
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemax={maxValue}
      aria-valuemin={0}
      aria-valuenow={clamped}
      aria-valuetext={valueText}
      className={`audio-loop-handle audio-loop-handle-${marker}${active ? " is-active" : ""}`}
      onKeyDown={onKeyDown(marker)}
      onPointerDown={onPointerDown(marker)}
      role="slider"
      style={{ left: percent }}
      type="button"
    />
  );
}

function MsField({
  label,
  onCommit,
  value,
}: {
  label: string;
  onCommit(raw: number): number | null;
  value: number;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    const raw = inputRef.current?.value ?? String(value);
    const parsed = Number(raw);
    const resolved =
      raw.trim() === "" || !Number.isFinite(parsed) ? null : onCommit(parsed);
    if (inputRef.current !== null)
      inputRef.current.value = String(resolved ?? value);
  };
  const pendingCommit = usePendingCommit(commit);
  return (
    <Field label={label}>
      <input
        defaultValue={String(value)}
        inputMode="numeric"
        key={String(value)}
        min={0}
        {...pendingCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !isComposing(event)) {
            event.preventDefault();
            commit();
          }
        }}
        ref={inputRef}
        step={1}
        type="number"
      />
    </Field>
  );
}

function Waveform({ peaks }: { peaks: number[] | null }): ReactElement {
  const path = useMemo(() => {
    if (peaks === null || peaks.length === 0) return "";
    const top: string[] = [];
    const bottom: string[] = [];
    const last = peaks.length - 1;
    peaks.forEach((peak, index) => {
      const x = last === 0 ? 50 : (index / last) * 100;
      const amplitude = Math.max(0, Math.min(1, peak));
      top.push(`${x.toFixed(2)},${(50 - amplitude * 48).toFixed(2)}`);
      bottom.push(`${x.toFixed(2)},${(50 + amplitude * 48).toFixed(2)}`);
    });
    return `M${top.join(" L")} L${bottom.reverse().join(" L")} Z`;
  }, [peaks]);
  return (
    <svg
      aria-hidden="true"
      className="audio-loop-waveform"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <line className="audio-loop-axis" x1="0" x2="100" y1="50" y2="50" />
      {path !== "" && <path d={path} />}
    </svg>
  );
}
