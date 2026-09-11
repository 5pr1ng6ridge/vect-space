import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  type ButtonSnapshot,
  type ButtonState,
  type PresentationCue,
  type RuntimeSnapshot,
} from "@vectspace/presentation-core/types";
import { evaluateChannel } from "@vectspace/presentation-core/timeline";
import {
  resolveImageAsset,
  type AnimationMap,
} from "@vectspace/presentation-core/image-animation";
import type { AssetUrlMap } from "../engine/types";
import { AnimatedImage } from "./AnimatedImage";

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

/** DOM buttons sit above Pixi so transparent hit areas remain interactive. */
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
  const elementRef = useRef<HTMLButtonElement>(null);
  const activePointerRef = useRef<number | null>(null);
  const insideRef = useRef(false);
  const [state, setState] = useState<ButtonState>("normal");
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef(0);
  const animation = button.animations[state];
  // Runtime snapshots are cloned for every revision. Use the serialized
  // animation shape as the dependency so an unrelated story update does not
  // restart a state animation that is already holding its last frame.
  const animationKey =
    animation === undefined || animation === null
      ? ""
      : JSON.stringify(animation);
  const animationRef = useRef(animation);
  useEffect(() => {
    animationRef.current = animation;
  }, [animation]);

  useEffect(() => {
    elapsedRef.current = 0;
    const frame = requestAnimationFrame(() => setElapsed(0));
    return () => cancelAnimationFrame(frame);
  }, [animationKey, state]);
  useEffect(() => {
    if (animationKey === "" || paused) return undefined;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const currentAnimation = animationRef.current;
      if (currentAnimation === undefined || currentAnimation === null) return;
      elapsedRef.current = Math.min(
        currentAnimation.duration_ms,
        elapsedRef.current +
          Math.max(0, now - previous) * Math.max(0.01, playbackRate),
      );
      setElapsed(elapsedRef.current);
      previous = now;
      if (elapsedRef.current < currentAnimation.duration_ms)
        frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animationKey, paused, playbackRate]);

  useEffect(() => {
    activePointerRef.current = null;
    insideRef.current = false;
    const frame = requestAnimationFrame(() => setState("normal"));
    return () => cancelAnimationFrame(frame);
  }, [sessionKey]);

  useEffect(() => {
    if (!disabled && button.enabled && button.visible) return undefined;
    const frame = requestAnimationFrame(() => {
      activePointerRef.current = null;
      insideRef.current = false;
      setState("normal");
    });
    return () => cancelAnimationFrame(frame);
  }, [button.enabled, button.visible, disabled]);

  useEffect(() => {
    const cancel = (): void => {
      activePointerRef.current = null;
      insideRef.current = false;
      setState("normal");
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);

  if (!button.visible) return null;

  const motion = animation?.channels ?? {};
  const x = evaluateChannel(motion, "offset_x", elapsed, 0);
  const y = evaluateChannel(motion, "offset_y", elapsed, 0);
  const scaleX = evaluateChannel(motion, "scale_x", elapsed, 1);
  const scaleY = evaluateChannel(motion, "scale_y", elapsed, 1);
  const rotation = evaluateChannel(motion, "rotation_deg", elapsed, 0);
  const opacity = evaluateChannel(motion, "opacity", elapsed, 1);
  const style: CSSProperties = {
    left: button.x,
    top: button.y,
    width: button.width,
    height: button.height,
    opacity: button.opacity,
    zIndex: button.z,
    transform: `translate3d(0, 0, 0) rotate(${button.rotation_deg}deg) scale(${button.scale_x}, ${button.scale_y})`,
  };
  const visualStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    opacity,
    transform: `translate3d(${x}px, ${y}px, 0) rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`,
    transformOrigin: "center",
  };
  const normalSource = resolveImageAsset(
    button.normal ?? "",
    assets,
    animations,
  );
  const stateId =
    state === "normal"
      ? button.normal
      : button.asset_mode === "separate"
        ? state === "hover"
          ? (button.hover ?? button.normal)
          : (button.pressed ?? button.normal)
        : state === "hover"
          ? button.hover
          : button.pressed;
  // Switching state resolves a different asset id, which starts that state's
  // animation from its first frame; a same-state re-render keeps the player
  // and therefore the current frame.
  const stateSource = resolveImageAsset(stateId ?? "", assets, animations);
  const overlay = button.asset_mode === "overlay" && state !== "normal";

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (disabled || !button.enabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    activePointerRef.current = event.pointerId;
    if (typeof event.currentTarget.setPointerCapture === "function")
      event.currentTarget.setPointerCapture(event.pointerId);
    insideRef.current = true;
    setState("pressed");
  };
  const handlePointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (activePointerRef.current !== event.pointerId) return;
    const nextInside = pointerIsInside(
      event.currentTarget,
      event.clientX,
      event.clientY,
      insideRef.current,
    );
    insideRef.current = nextInside;
    setState(nextInside ? "pressed" : "normal");
  };
  const handlePointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (activePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const releasedInside = pointerIsInside(
      event.currentTarget,
      event.clientX,
      event.clientY,
      insideRef.current,
    );
    const shouldClick =
      !disabled && button.visible && button.enabled && releasedInside;
    activePointerRef.current = null;
    insideRef.current = releasedInside;
    setState(releasedInside ? "hover" : "normal");
    if (shouldClick) onClick(button.id);
  };

  return (
    <button
      aria-label={button.id}
      className={`scene-button scene-button-${state}`}
      disabled={disabled || !button.enabled}
      onPointerCancel={(event) => {
        if (activePointerRef.current === event.pointerId) {
          activePointerRef.current = null;
          insideRef.current = false;
          setState("normal");
        }
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={handlePointerDown}
      onPointerEnter={() => {
        insideRef.current = true;
        if (activePointerRef.current === null && !disabled && button.enabled)
          setState("hover");
      }}
      onPointerLeave={() => {
        insideRef.current = false;
        if (activePointerRef.current === null) setState("normal");
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      ref={elementRef}
      style={style}
      type="button"
    >
      <span className="scene-button-visual" style={visualStyle}>
        {normalSource !== undefined && overlay && (
          <AnimatedImage
            alt=""
            className="scene-button-image"
            paused={paused}
            source={normalSource}
            style={{ objectFit: cssFit(button.fit) }}
          />
        )}
        {!overlay && stateSource !== undefined && (
          <AnimatedImage
            alt=""
            className="scene-button-image"
            paused={paused}
            source={stateSource}
            style={{ objectFit: cssFit(button.fit) }}
          />
        )}
        {overlay && stateSource !== undefined && (
          <AnimatedImage
            alt=""
            className="scene-button-image"
            paused={paused}
            source={stateSource}
            style={{ objectFit: cssFit(button.fit) }}
          />
        )}
      </span>
    </button>
  );
}

function cssFit(fit: ButtonSnapshot["fit"]): CSSProperties["objectFit"] {
  return fit === "stretch" ? "fill" : fit;
}

function pointerIsInside(
  element: HTMLButtonElement,
  clientX: number,
  clientY: number,
  fallback: boolean,
): boolean {
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    try {
      const hit = document.elementFromPoint(clientX, clientY);
      if (hit !== null) return hit === element || element.contains(hit);
    } catch {
      // Some test DOMs do not implement elementFromPoint. Use the geometric
      // fallback below in that environment.
    }
    const rect = element.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }
  return fallback;
}
