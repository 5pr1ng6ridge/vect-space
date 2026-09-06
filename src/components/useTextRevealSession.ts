import {
  TextRevealSession,
  type MarkupUnit,
  type RevealPlan,
  type RevealSessionState,
} from "@vectspace/text";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { TextRevealAnimation } from "../engine/types";

export interface UseTextRevealSessionOptions {
  /** Must change for every RuntimeUpdate/prompt presentation instance. */
  instanceKey: string;
  units: MarkupUnit[];
  initialCps: number;
  defaultCps: number;
  mathRevealDurations?: ReadonlyMap<number, number>;
  animation: TextRevealAnimation;
  /** Keep inline formula animation concurrent only in drop-fade mode. */
  waitForInlineMath: boolean;
  /** Font and visual-line measurement are ready to start a live reveal. */
  ready: boolean;
  /** A saved/no-cue presentation starts at its final stable state. */
  restorePresentation: boolean;
  /** Menus and hidden documents freeze the same virtual clock. */
  suspended?: boolean;
  onComplete?(): void;
}

export interface TextRevealSessionHandle {
  plan: RevealPlan;
  state: RevealSessionState;
  /** A frame clock for visual adapters; subscribers must not trigger React renders. */
  clock: TextRevealClock;
  completeReveal(): void;
  restorePresentation(): void;
  cancel(): void;
  isComplete(): boolean;
}

export interface TextRevealClock {
  getElapsedMs(): number;
  subscribe(listener: (elapsedMs: number) => void): () => void;
}

class RevealClockStore implements TextRevealClock {
  private elapsedMs: number;
  private readonly listeners = new Set<(elapsedMs: number) => void>();

  constructor(initialElapsedMs: number) {
    this.elapsedMs = initialElapsedMs;
  }

  getElapsedMs(): number {
    return this.elapsedMs;
  }

  subscribe(listener: (elapsedMs: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setElapsedMs(elapsedMs: number): void {
    if (this.elapsedMs === elapsedMs) return;
    this.elapsedMs = elapsedMs;
    for (const listener of this.listeners) listener(elapsedMs);
  }
}

interface RenderedSession {
  key: string;
  session: TextRevealSession;
}

const EMPTY_DURATIONS: ReadonlyMap<number, number> = new Map();

/**
 * React adapter around the pure shared TextRevealSession.
 *
 * The session itself is immutable.  This hook owns one session for one
 * presentation instance and rejects RAF callbacks from a cancelled/older
 * instance, which is the important distinction a stable prompt_id alone
 * cannot make after a revisit or a load.
 */
export function useTextRevealSession(
  options: UseTextRevealSessionOptions,
): TextRevealSessionHandle {
  const {
    animation,
    defaultCps,
    initialCps,
    instanceKey,
    mathRevealDurations = EMPTY_DURATIONS,
    onComplete,
    ready,
    restorePresentation: shouldRestore,
    suspended = false,
    units,
    waitForInlineMath,
  } = options;
  const planInput = useMemo(
    () => ({
      units,
      initialCps,
      defaultCps,
      mathRevealDurations,
      animation,
      waitForInlineMath,
    }),
    [
      animation,
      defaultCps,
      initialCps,
      mathRevealDurations,
      units,
      waitForInlineMath,
    ],
  );
  const makeSession = useCallback(
    (restore: boolean): TextRevealSession => {
      const session = new TextRevealSession(planInput);
      return restore ? session.restorePresentation() : session;
    },
    [planInput],
  );
  const [rendered, setRendered] = useState<RenderedSession>(() => ({
    key: instanceKey,
    session: makeSession(shouldRestore),
  }));
  const renderedRef = useRef(rendered);
  const [clock] = useState(
    () => new RevealClockStore(rendered.session.state.elapsedMs),
  );
  const sessionRef = useRef<TextRevealSession>(rendered.session);
  const instanceRef = useRef<string>(instanceKey);
  const epochRef = useRef(0);
  const completionRef = useRef<string | null>(null);

  const commit = useCallback(
    (next: TextRevealSession, forceRender = false): void => {
      const previous = renderedRef.current;
      sessionRef.current = next;
      clock.setElapsedMs(next.state.elapsedMs);
      const stateChanged =
        previous.key !== instanceRef.current ||
        previous.session.state.status !== next.state.status ||
        previous.session.state.revealedCount !== next.state.revealedCount ||
        previous.session.state.activePause !== next.state.activePause ||
        previous.session.state.restored !== next.state.restored ||
        previous.session.state.completionMs !== next.state.completionMs;
      if (!stateChanged && !forceRender) return;
      const nextRendered = { key: instanceRef.current, session: next };
      renderedRef.current = nextRendered;
      setRendered(nextRendered);
    },
    [clock],
  );

  // A prompt instance is the only unconditional reset boundary.  Timing
  // metrics may settle before the reveal begins; while still preparing it is
  // safe to replace the plan, but once it has visible text its plan remains
  // fixed until the next instance.
  useLayoutEffect(() => {
    const current = sessionRef.current;
    const changedInstance = instanceRef.current !== instanceKey;
    const mayRefreshPlan =
      changedInstance ||
      current.state.status === "preparing" ||
      current.state.status === "cancelled";
    if (!mayRefreshPlan) return;
    epochRef.current += 1;
    instanceRef.current = instanceKey;
    completionRef.current = null;
    commit(makeSession(shouldRestore), true);
  }, [commit, instanceKey, makeSession, shouldRestore]);

  // Loading a stable snapshot can arrive after the component has mounted
  // (for example while a cue is being replaced).  It is intentionally the
  // only prop transition that is allowed to jump to the final presentation;
  // Ctrl calls completeReveal() instead and therefore cannot bypass scroll.
  useEffect(() => {
    if (!shouldRestore || sessionRef.current.state.restored) return;
    epochRef.current += 1;
    commit(sessionRef.current.restorePresentation(), true);
  }, [commit, shouldRestore]);

  useEffect(() => {
    if (!ready || suspended) return;
    const activeEpoch = ++epochRef.current;
    let frame = 0;
    let previous = performance.now();

    const tick = (now: number): void => {
      if (activeEpoch !== epochRef.current) return;
      const current = sessionRef.current;
      if (
        current.state.status === "completed" ||
        current.state.status === "cancelled"
      ) {
        return;
      }
      const resumed =
        current.state.status === "paused" ? current.resume() : current;
      const next = resumed.advance(Math.min(50, Math.max(0, now - previous)));
      previous = now;
      commit(next);
      if (
        next.state.status !== "completed" &&
        next.state.status !== "cancelled"
      ) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      ++epochRef.current;
      cancelAnimationFrame(frame);
    };
  }, [commit, ready, suspended]);

  useEffect(() => {
    if (!suspended) return;
    const current = sessionRef.current;
    if (
      current.state.status !== "completed" &&
      current.state.status !== "cancelled" &&
      current.state.status !== "paused"
    ) {
      commit(current.pause(), true);
    }
  }, [commit, suspended]);

  useEffect(() => {
    if (
      rendered.key !== instanceKey ||
      rendered.session.state.status !== "completed" ||
      completionRef.current === instanceKey
    ) {
      return;
    }
    completionRef.current = instanceKey;
    onComplete?.();
  }, [instanceKey, onComplete, rendered]);

  const completeReveal = useCallback((): void => {
    epochRef.current += 1;
    commit(sessionRef.current.completeReveal(), true);
  }, [commit]);

  const restorePresentation = useCallback((): void => {
    epochRef.current += 1;
    commit(sessionRef.current.restorePresentation(), true);
  }, [commit]);

  const cancel = useCallback((): void => {
    epochRef.current += 1;
    commit(sessionRef.current.cancel(), true);
  }, [commit]);

  const isComplete = useCallback(
    (): boolean => sessionRef.current.state.status === "completed",
    [],
  );

  // Effects reset the mutable session after React commits.  Do not let that
  // one render frame borrow the previous prompt's plan/state: it can otherwise
  // briefly expose a completed old sentence when a repeated prompt_id is
  // presented by a new RuntimeUpdate.
  const pendingSession = useMemo(
    () => makeSession(shouldRestore),
    [makeSession, shouldRestore],
  );
  const displayedSession =
    rendered.key === instanceKey ? rendered.session : pendingSession;

  return {
    plan: displayedSession.plan,
    state: displayedSession.state,
    clock,
    completeReveal,
    restorePresentation,
    cancel,
    isComplete,
  };
}
