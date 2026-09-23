import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  imageAssetSourceVersion,
  resolveImageAsset,
  type AnimationMap,
  type ImageAssetSource,
} from "@vectspace/presentation-core/image-animation";
import { evaluateChannel } from "@vectspace/presentation-core/timeline";
import type {
  AssetUrlMap,
  ButtonSnapshot,
  ButtonState,
} from "@vectspace/presentation-core/types";

import { AnimatedImage } from "../AnimatedImage";

const EMPTY_ARTWORK_FAILURES: ReadonlySet<string> = new Set();

/**
 * How a template button activates.
 *
 * `manual` is the story-button contract: the component owns the pointer
 * sequence and fires on pointer-up *inside* the hit box, so a press that
 * leaves the button does not activate it.  `native` keeps the native `<button>`
 * click (pointer and keyboard alike) and only decorates the pointer state, so
 * a keyboard user can activate it with Enter/Space.
 */
export type ButtonActivationMode = "manual" | "native";

export interface TemplateButtonProps {
  button: ButtonSnapshot;
  assets: AssetUrlMap;
  /** Frame lists for animated button artwork.  Defaults to static-only. */
  animations?: AnimationMap;
  disabled?: boolean;
  paused?: boolean;
  playbackRate?: number;
  /**
   * Base CSS class.  The interaction state is appended as
   * `{className}-{state}` so existing selectors keep working.
   */
  className: string;
  style?: CSSProperties;
  /** Stable identity; a changed value drops hover/pressed immediately. */
  sessionKey: string;
  activation?: ButtonActivationMode;
  /**
   * Forces the rendered state instead of the pointer state machine.
   *
   * Authoring previews (the editor button workspace) scrub one authored
   * state at a time and must not depend on a real hover/press, so they pin
   * this to the selected state.  Omitted, the pointer owns the state exactly
   * as before, which keeps the game and choice behaviour untouched.
   */
  state?: ButtonState;
  /**
   * Content rendered above the artwork (choice labels).  Story buttons pass
   * nothing and stay artwork-only.
   */
  children?: ReactNode;
  /** Accessible name; defaults to the button id. */
  ariaLabel?: string;
  /** Stable identity for focus bookkeeping (choice items). */
  dataChoiceId?: string;
  /** Rendered when no artwork url resolves, so a missing image never locks. */
  fallbackClassName?: string;
  onActivate(): void;
}

export interface ButtonInteractionHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerEnter(): void;
  onPointerLeave(): void;
  onPointerCancel(event: ReactPointerEvent<HTMLButtonElement>): void;
  onFocus(): void;
  onBlur(): void;
  onClick(event: ReactMouseEvent<HTMLButtonElement>): void;
}

export interface ButtonInteraction {
  /** Visual pointer state; never `disabled`. */
  state: ButtonState;
  /** DOM focus, including programmatic focus (used for the focus ring). */
  focused: boolean;
  handlers: ButtonInteractionHandlers;
}

/**
 * The shared normal/hover/pressed state machine of a template button.
 *
 * It is deliberately host-free: both a story button placed by the runtime and
 * a choice button placed by a prompt snapshot use it, so their hover, press,
 * cancel-on-blur and session-reset behaviour cannot drift apart.  Deferred
 * resets go through `requestAnimationFrame`, which also keeps Strict Mode's
 * double-invoked effects from double-applying a state transition.
 */
export function useButtonInteraction({
  enabled,
  disabled,
  visible,
  sessionKey,
  activation,
  onActivate,
}: {
  enabled: boolean;
  disabled: boolean;
  visible: boolean;
  sessionKey: string;
  activation: ButtonActivationMode;
  onActivate(): void;
}): ButtonInteraction {
  const activePointerRef = useRef<number | null>(null);
  const insideRef = useRef(false);
  // A pointer capture retargets the browser's `click` to this button even when
  // the pointer was released outside it, so native activation remembers whether
  // the gesture actually ended inside and swallows a stray click otherwise.
  const clickAllowedRef = useRef(true);
  const [state, setState] = useState<ButtonState>("normal");
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    activePointerRef.current = null;
    insideRef.current = false;
    const frame = requestAnimationFrame(() => setState("normal"));
    return () => cancelAnimationFrame(frame);
  }, [sessionKey]);

  useEffect(() => {
    if (!disabled && enabled) return undefined;
    const frame = requestAnimationFrame(() => {
      activePointerRef.current = null;
      insideRef.current = false;
      setState("normal");
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, disabled]);

  // A hidden button leaves the DOM entirely, so no pointer or focus state may
  // survive the hide/show round trip: a button that was pressed when it
  // disappeared must come back normal, and a focus ring from the previous
  // mount must not be re-applied.
  useLayoutEffect(() => {
    if (visible) return undefined;
    activePointerRef.current = null;
    insideRef.current = false;
    clickAllowedRef.current = true;
    setState("normal");
    setFocused(false);
    return undefined;
  }, [visible]);

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

  const onActivateRef = useRef(onActivate);
  useEffect(() => {
    onActivateRef.current = onActivate;
  }, [onActivate]);

  const interactive = !disabled && enabled;

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!interactive || event.button !== 0) return;
      activePointerRef.current = event.pointerId;
      clickAllowedRef.current = true;
      if (typeof event.currentTarget.setPointerCapture === "function")
        event.currentTarget.setPointerCapture(event.pointerId);
      insideRef.current = true;
      if (activation === "manual") {
        event.preventDefault();
        event.stopPropagation();
      }
      setState("pressed");
    },
    [activation, interactive],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (activePointerRef.current !== event.pointerId) return;
      const nextInside = pointerIsInside(
        event.currentTarget,
        event.clientX,
        event.clientY,
        insideRef.current,
      );
      insideRef.current = nextInside;
      setState(nextInside ? "pressed" : "normal");
    },
    [],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (activePointerRef.current !== event.pointerId) return;
      const releasedInside = pointerIsInside(
        event.currentTarget,
        event.clientX,
        event.clientY,
        insideRef.current,
      );
      activePointerRef.current = null;
      insideRef.current = releasedInside;
      clickAllowedRef.current = releasedInside;
      if (activation === "manual") {
        event.preventDefault();
        event.stopPropagation();
      }
      setState(releasedInside ? "hover" : "normal");
      if (activation === "manual" && interactive && releasedInside)
        onActivateRef.current();
    },
    [activation, interactive],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (activePointerRef.current !== event.pointerId) return;
      activePointerRef.current = null;
      insideRef.current = false;
      setState("normal");
    },
    [],
  );

  const onPointerEnter = useCallback((): void => {
    insideRef.current = true;
    if (activePointerRef.current === null && interactive) setState("hover");
  }, [interactive]);

  const onPointerLeave = useCallback((): void => {
    insideRef.current = false;
    if (activePointerRef.current === null) setState("normal");
  }, []);

  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>): void => {
      if (activation === "manual") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!interactive) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!clickAllowedRef.current) {
        // Released outside the hit box: a captured pointer still produces a
        // click, but a plain button would not have activated.
        clickAllowedRef.current = true;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onActivateRef.current();
    },
    [activation, interactive],
  );

  return {
    state,
    focused,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerEnter,
      onPointerLeave,
      onPointerCancel,
      onFocus: () => {
        setFocused(true);
        if (interactive && activePointerRef.current === null) setState("hover");
      },
      onBlur: () => {
        setFocused(false);
        if (activePointerRef.current === null) setState("normal");
      },
      onClick,
    },
  };
}

/**
 * One resolved template button.
 *
 * The component renders the resolved artwork of the current state (falling
 * back to the normal state for `separate` skins), applies that state's
 * declarative animation channels, and never recomputes placement: the caller
 * owns the rect, because a story button's rect comes from the runtime and a
 * choice item's rect comes from the prompt layout.
 */
export function TemplateButton({
  button,
  assets,
  animations = {},
  disabled = false,
  paused = false,
  playbackRate = 1,
  className,
  style,
  sessionKey,
  activation = "manual",
  state: forcedState,
  children,
  ariaLabel,
  dataChoiceId,
  fallbackClassName,
  onActivate,
}: TemplateButtonProps): ReactElement | null {
  const interaction = useButtonInteraction({
    enabled: button.enabled,
    visible: button.visible,
    disabled,
    sessionKey,
    activation,
    onActivate,
  });
  const { focused, handlers } = interaction;
  const state = forcedState ?? interaction.state;
  const animation = button.animations[state];
  // Runtime snapshots are cloned for every revision. Use the serialized
  // animation shape as the dependency so an unrelated story update does not
  // restart a state animation that is already holding its last frame.
  const animationKey =
    animation === undefined || animation === null
      ? ""
      : JSON.stringify(animation);
  const animationRef = useRef(animation);
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef(0);
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

  const motion = animation?.channels ?? {};
  const x = evaluateChannel(motion, "offset_x", elapsed, 0);
  const y = evaluateChannel(motion, "offset_y", elapsed, 0);
  const scaleX = evaluateChannel(motion, "scale_x", elapsed, 1);
  const scaleY = evaluateChannel(motion, "scale_y", elapsed, 1);
  const rotation = evaluateChannel(motion, "rotation_deg", elapsed, 0);
  const opacity = evaluateChannel(motion, "opacity", elapsed, 1);
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
  // Artwork decode/load failures demote the button to its fallback text skin:
  // the failed source never renders again (no stale image), the native button
  // stays enabled, and the shared interaction state machine keeps working.
  const [failedArtwork, setFailedArtwork] = useState<ReadonlySet<string>>(
    EMPTY_ARTWORK_FAILURES,
  );
  const onArtworkError = useCallback(
    (source: ImageAssetSource | undefined): void => {
      if (source === undefined) return;
      const key = imageAssetSourceVersion(source);
      if (key === "") return;
      setFailedArtwork((previous) => {
        if (previous.has(key)) return previous;
        const next = new Set(previous);
        next.add(key);
        return next;
      });
    },
    [],
  );
  const requiredArtwork = (
    overlay ? [normalSource, stateSource] : [stateSource]
  ).filter((source): source is ImageAssetSource => source !== undefined);
  const hasArtwork =
    requiredArtwork.length > 0 &&
    requiredArtwork.every(
      (source) => !failedArtwork.has(imageAssetSourceVersion(source)),
    );
  const stateClass = `${className}-${state}`;
  const fallbackClass =
    fallbackClassName === undefined || hasArtwork
      ? ""
      : ` ${fallbackClassName}`;

  if (!button.visible) return null;

  return (
    <button
      aria-label={ariaLabel ?? button.id}
      className={`${className} ${stateClass}${
        focused ? " is-focused" : ""
      }${disabled || !button.enabled ? " is-disabled" : ""}${fallbackClass}`}
      data-choice-id={dataChoiceId}
      disabled={disabled || !button.enabled}
      {...handlers}
      style={style}
      type="button"
    >
      <span className={`${className}-visual`} style={visualStyle}>
        {hasArtwork && normalSource !== undefined && overlay && (
          <AnimatedImage
            alt=""
            className={`${className}-image`}
            onError={() => onArtworkError(normalSource)}
            paused={paused}
            source={normalSource}
            style={{ objectFit: cssFit(button.fit) }}
          />
        )}
        {hasArtwork && !overlay && stateSource !== undefined && (
          <AnimatedImage
            alt=""
            className={`${className}-image`}
            onError={() => onArtworkError(stateSource)}
            paused={paused}
            source={stateSource}
            style={{ objectFit: cssFit(button.fit) }}
          />
        )}
        {hasArtwork && overlay && stateSource !== undefined && (
          <AnimatedImage
            alt=""
            className={`${className}-image`}
            onError={() => onArtworkError(stateSource)}
            paused={paused}
            source={stateSource}
            style={{ objectFit: cssFit(button.fit) }}
          />
        )}
        {children !== undefined && (
          <span className={`${className}-content`}>{children}</span>
        )}
      </span>
    </button>
  );
}

export function cssFit(fit: ButtonSnapshot["fit"]): CSSProperties["objectFit"] {
  return fit === "stretch" ? "fill" : fit;
}

export function pointerIsInside(
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
