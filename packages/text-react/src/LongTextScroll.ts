import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  LongTextScrollController,
  type LongTextScrollState,
} from "@vectspace/text";

export interface UseLongTextScrollOptions {
  readonly initialPosition?: number;
  /** Changes only when the displayed document should be reset. */
  readonly resetKey?: string;
  readonly target: number;
  readonly maxScroll: number;
  readonly fastForward?: boolean;
  readonly enabled?: boolean;
  readonly suspended?: boolean;
  onOffsetChange(offset: number, state: LongTextScrollState): void;
}

export interface LongTextScrollHandle {
  readonly controller: MutableRefObject<LongTextScrollController | null>;
  setTarget(target: number): void;
  setPosition(position: number, notify?: boolean): void;
  getState(): LongTextScrollState;
  wake(): void;
}

/**
 * A single RAF driver shared by gameplay and editor previews.  The driver is
 * created once per mounted document; changing a target or speed only updates
 * refs and wakes the existing loop, so a page boundary cannot restart motion.
 */
export function useLongTextScroll(
  options: UseLongTextScrollOptions,
): LongTextScrollHandle {
  const controllerRef = useRef<LongTextScrollController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new LongTextScrollController({
      position: options.initialPosition ?? 0,
      target: options.target,
      maxScroll: options.maxScroll,
    });
  }
  const enabledRef = useRef(options.enabled ?? true);
  const suspendedRef = useRef(options.suspended ?? false);
  const fastForwardRef = useRef(options.fastForward ?? false);
  const callbackRef = useRef(options.onOffsetChange);
  const resetKeyRef = useRef(options.resetKey);
  const frameRef = useRef(0);
  const lastTimeRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const scheduleRef = useRef<(() => void) | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() =>
    prefersReducedMotion(),
  );
  const reducedMotionRef = useRef(reducedMotion);

  const schedule = useCallback((): void => {
    if (
      disposedRef.current ||
      frameRef.current !== 0 ||
      !enabledRef.current ||
      suspendedRef.current ||
      reducedMotionRef.current
    ) {
      return;
    }
    frameRef.current = requestAnimationFrame((now) => {
      frameRef.current = 0;
      if (disposedRef.current || !enabledRef.current || suspendedRef.current) {
        lastTimeRef.current = null;
        return;
      }
      const previous = lastTimeRef.current ?? now;
      lastTimeRef.current = now;
      const controller = controllerRef.current;
      if (controller === null) return;
      const state = controller.advance(
        Math.min(50, Math.max(0, now - previous)),
        fastForwardRef.current,
      );
      callbackRef.current(state.position, state);
      if (!state.settled) scheduleRef.current?.();
      else lastTimeRef.current = null;
    });
  }, []);

  scheduleRef.current = schedule;

  useLayoutEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    // This also makes the driver safe under React StrictMode's development
    // effect replay: the passive cleanup from the first mount must not leave
    // the second layout effect permanently marked as disposed.
    disposedRef.current = false;
    reducedMotionRef.current = reducedMotion;
    // Publish the callback before applying a reset.  A reset is a visible
    // position change, so the caller's DOM transform and position refs must be
    // updated in the same layout pass as the controller.
    callbackRef.current = options.onOffsetChange;
    enabledRef.current = options.enabled ?? true;
    suspendedRef.current = options.suspended ?? false;
    fastForwardRef.current = options.fastForward ?? false;
    controller.setBounds(options.maxScroll);
    if (
      options.resetKey !== undefined &&
      resetKeyRef.current !== options.resetKey
    ) {
      controller.setPosition(options.initialPosition ?? 0);
      resetKeyRef.current = options.resetKey;
      const state = controller.getState();
      callbackRef.current(state.position, state);
      lastTimeRef.current = null;
    }
    controller.setTarget(options.target);
    if (reducedMotion) {
      controller.setPosition(options.target);
      callbackRef.current(
        controller.getState().position,
        controller.getState(),
      );
    }
    if (reducedMotion || suspendedRef.current || !enabledRef.current) {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      lastTimeRef.current = null;
      return;
    }
    schedule();
  }, [
    options.enabled,
    options.fastForward,
    options.maxScroll,
    options.onOffsetChange,
    options.initialPosition,
    options.resetKey,
    reducedMotion,
    options.suspended,
    options.target,
    schedule,
  ]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return undefined;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (event: MediaQueryListEvent): void => {
      setReducedMotion(event.matches);
    };
    query.addEventListener?.("change", handleChange);
    return () => query.removeEventListener?.("change", handleChange);
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      lastTimeRef.current = null;
    };
  }, []);

  const setTarget = useCallback((target: number): void => {
    const controller = controllerRef.current;
    if (controller === null) return;
    if (reducedMotionRef.current) {
      controller.setTarget(target);
      controller.setPosition(target);
      callbackRef.current(
        controller.getState().position,
        controller.getState(),
      );
      return;
    }
    controller.setTarget(target);
    scheduleRef.current?.();
  }, []);
  const setPosition = useCallback((position: number, notify = true): void => {
    const controller = controllerRef.current;
    if (controller === null) return;
    controller.setPosition(position);
    const state = controller.getState();
    if (notify) callbackRef.current(state.position, state);
    lastTimeRef.current = null;
  }, []);
  const getState = useCallback((): LongTextScrollState => {
    return (
      controllerRef.current?.getState() ?? {
        position: 0,
        target: 0,
        velocity: 0,
        settled: true,
      }
    );
  }, []);
  return useMemo(
    () => ({
      controller: controllerRef,
      setTarget,
      setPosition,
      getState,
      wake: schedule,
    }),
    [getState, schedule, setPosition, setTarget],
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
