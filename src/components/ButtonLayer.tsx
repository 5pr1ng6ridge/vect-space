import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import {
  type ButtonSnapshot,
  type PresentationCue,
  type RuntimeSnapshot,
} from "@vectspace/presentation-core/types";
import { evaluateChannel } from "@vectspace/presentation-core/timeline";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { TemplateButton } from "@vectspace/presentation-react/button";
import type { AssetUrlMap } from "../engine/types";

interface ButtonLayerProps {
  snapshot: RuntimeSnapshot;
  assets: AssetUrlMap;
  /** Frame lists for animated button artwork.  Defaults to static-only. */
  animations?: AnimationMap;
  disabled?: boolean;
  paused?: boolean;
  playbackRate?: number;
  onClick(instanceId: string): void;
  timeline?: Extract<PresentationCue, { type: "timeline" }> | null;
}

/**
 * Places the story buttons of the current runtime snapshot.
 *
 * The component owns only the layer-level concerns — timeline evaluation,
 * z-order and the per-session placement key.  Every button's state machine and
 * artwork rendering come from the shared `TemplateButton`, which is the same
 * implementation a template-driven choice item uses.
 */
export function ButtonLayer({
  snapshot,
  assets,
  animations = {},
  disabled = false,
  paused = false,
  playbackRate = 1,
  onClick,
  timeline = null,
}: ButtonLayerProps): ReactElement {
  const [previousButtons, setPreviousButtons] = useState<
    Record<string, ButtonSnapshot>
  >({});
  const [timelineElapsed, setTimelineElapsed] = useState(0);
  const timelineElapsedRef = useRef(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      setPreviousButtons(snapshot.world.buttons ?? {}),
    );
    return () => cancelAnimationFrame(frame);
  }, [snapshot.revision, snapshot.world.buttons]);
  useEffect(() => {
    timelineElapsedRef.current = 0;
    const frame = requestAnimationFrame(() => setTimelineElapsed(0));
    return () => cancelAnimationFrame(frame);
  }, [timeline]);
  useEffect(() => {
    if (timeline === null || timeline.duration_ms <= 0 || paused)
      return undefined;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const rate = Math.max(0.01, playbackRate);
      timelineElapsedRef.current = Math.min(
        timeline.duration_ms,
        timelineElapsedRef.current + Math.max(0, now - previous) * rate,
      );
      setTimelineElapsed(timelineElapsedRef.current);
      previous = now;
      if (timelineElapsedRef.current < timeline.duration_ms)
        frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paused, playbackRate, timeline]);
  const buttons = Object.values(snapshot.world.buttons ?? {})
    .map((button) =>
      applyTimelineButton(
        button,
        previousButtons[button.id],
        timeline,
        timelineElapsed,
      ),
    )
    .sort((left, right) => left.z - right.z || left.id.localeCompare(right.id));
  return (
    <div className="button-layer" aria-label="剧情按钮">
      {buttons.map((button) => (
        <SceneButton
          animations={animations}
          assets={assets}
          button={button}
          disabled={disabled}
          key={button.id}
          onClick={onClick}
          paused={paused}
          playbackRate={playbackRate}
          sessionKey={`${snapshot.session_id ?? "legacy"}:${snapshot.location.scene_id}:${button.template}`}
        />
      ))}
    </div>
  );
}

function applyTimelineButton(
  button: ButtonSnapshot,
  previous: ButtonSnapshot | undefined,
  timeline: Extract<PresentationCue, { type: "timeline" }> | null,
  elapsed: number,
): ButtonSnapshot {
  const track = timeline?.tracks.find(
    (candidate) =>
      candidate.type === "button" && candidate.instance_id === button.id,
  );
  if (track === undefined || track.type !== "button") return button;
  const timelineBase = timeline?.button_bases?.[button.id];
  const base =
    timelineBase === undefined
      ? (previous ?? button)
      : { ...button, ...timelineBase };
  return {
    ...button,
    x: evaluateChannel(track.channels, "x", elapsed, base.x),
    y: evaluateChannel(track.channels, "y", elapsed, base.y),
    width: evaluateChannel(track.channels, "width", elapsed, base.width),
    height: evaluateChannel(track.channels, "height", elapsed, base.height),
    scale_x: evaluateChannel(track.channels, "scale_x", elapsed, base.scale_x),
    scale_y: evaluateChannel(track.channels, "scale_y", elapsed, base.scale_y),
    rotation_deg: evaluateChannel(
      track.channels,
      "rotation_deg",
      elapsed,
      base.rotation_deg,
    ),
    opacity: evaluateChannel(track.channels, "opacity", elapsed, base.opacity),
    z: Math.round(evaluateChannel(track.channels, "z", elapsed, base.z)),
  };
}

/** Runtime placement only; interaction and artwork live in the shared button. */
function SceneButton({
  button,
  assets,
  animations,
  disabled,
  onClick,
  paused,
  playbackRate,
  sessionKey,
}: {
  button: ButtonSnapshot;
  assets: AssetUrlMap;
  animations: AnimationMap;
  disabled: boolean;
  onClick(instanceId: string): void;
  paused: boolean;
  playbackRate: number;
  sessionKey: string;
}): ReactElement | null {
  const style: CSSProperties = {
    left: button.x,
    top: button.y,
    width: button.width,
    height: button.height,
    opacity: button.opacity,
    zIndex: button.z,
    transform: `translate3d(0, 0, 0) rotate(${button.rotation_deg}deg) scale(${button.scale_x}, ${button.scale_y})`,
  };
  return (
    <TemplateButton
      animations={animations}
      assets={assets}
      button={button}
      className="scene-button"
      disabled={disabled}
      onActivate={() => onClick(button.id)}
      paused={paused}
      playbackRate={playbackRate}
      sessionKey={sessionKey}
      style={style}
    />
  );
}
