import {
  formulaRevealDurationForUnit,
  type MarkupUnit,
  type MathUnit,
  type PauseWindow,
  type RevealTimingOptions,
  revealUnits,
  type RevealUnit,
} from "./markup";

export type TextRevealAnimation = "line_sweep" | "typewriter" | "drop_fade";

export type RevealSessionStatus =
  | "preparing"
  | "revealing"
  | "waiting"
  | "paused"
  | "completed"
  | "cancelled";

export interface RevealEvent {
  revealIndex: number;
  unit: RevealUnit;
  atMs: number;
  animationEndMs: number;
}

export interface RevealPlan {
  units: MarkupUnit[];
  revealUnits: RevealUnit[];
  events: RevealEvent[];
  pauses: PauseWindow[];
  completionMs: number;
}

export interface TextRevealSessionOptions extends RevealTimingOptions {
  units: MarkupUnit[];
  initialCps: number;
  defaultCps: number;
  mathRevealDurations?: ReadonlyMap<number, number>;
  animation?: TextRevealAnimation;
}

export interface RevealSessionState {
  status: RevealSessionStatus;
  elapsedMs: number;
  revealedCount: number;
  revealedUnitIndices: readonly number[];
  activePause: PauseWindow | null;
  completionMs: number;
  /** True when the final state came from restorePresentation(). */
  restored: boolean;
}

/** Builds a deterministic plan. It performs no DOM work or scheduling. */
export function createRevealPlan(options: TextRevealSessionOptions): RevealPlan {
  const reveal = revealUnits(options.units);
  const events: RevealEvent[] = [];
  const pauses: PauseWindow[] = [];
  const durations = options.mathRevealDurations ?? new Map<number, number>();
  const animation = options.animation ?? "typewriter";
  let elapsed = 0;
  let cps = validCps(options.initialCps, options.defaultCps);
  let revealIndex = 0;
  let latestAnimationEnd = 0;

  for (const unit of options.units) {
    if (unit.kind === "pause") {
      pauses.push({
        startMs: elapsed,
        endMs: elapsed + unit.durationMs,
        span: unit.span,
      });
      elapsed += unit.durationMs;
      continue;
    }
    if (unit.kind === "speed") {
      cps = unit.cps === null ? validCps(options.defaultCps, 30) : validCps(unit.cps, options.defaultCps);
      continue;
    }
    if (unit.kind !== "character" && unit.kind !== "math") continue;

    elapsed += 1_000 / cps;
    const formulaDuration =
      unit.kind === "math"
        ? formulaRevealDurationForUnit(unit, durations.get(revealIndex), cps)
        : 0;
    const waitsForFormula = unit.kind === "math" && shouldWaitForMath(unit, options);
    const visualDuration =
      unit.kind === "math" && waitsForFormula
        ? formulaDuration
        : animation === "drop_fade"
          ? 160
          : animation === "line_sweep"
            ? 1_000 / cps
            : 0;
    const animationEndMs = elapsed + visualDuration;
    events.push({
      revealIndex,
      unit,
      atMs: elapsed,
      animationEndMs,
    });
    latestAnimationEnd = Math.max(latestAnimationEnd, animationEndMs);
    if (waitsForFormula) elapsed += formulaDuration;
    revealIndex += 1;
  }

  return {
    units: options.units,
    revealUnits: reveal,
    events,
    pauses,
    completionMs: Math.max(elapsed, latestAnimationEnd),
  };
}

export function initialRevealSessionState(plan: RevealPlan): RevealSessionState {
  return makeState(plan, 0, false, false);
}

/** Pure state transition: advances virtual presentation time by deltaMs. */
export function advanceRevealSession(
  plan: RevealPlan,
  state: RevealSessionState,
  deltaMs: number,
): RevealSessionState {
  if (state.status === "completed" || state.status === "cancelled" || state.status === "paused") return state;
  const delta = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
  return makeState(plan, Math.min(plan.completionMs, state.elapsedMs + delta), false, state.restored);
}

export function pauseRevealSession(
  _plan: RevealPlan,
  state: RevealSessionState,
): RevealSessionState {
  if (state.status === "completed" || state.status === "cancelled" || state.status === "paused") return state;
  return { ...state, status: "paused" };
}

export function resumeRevealSession(
  plan: RevealPlan,
  state: RevealSessionState,
): RevealSessionState {
  if (state.status !== "paused") return state;
  return makeState(plan, state.elapsedMs, false, state.restored);
}

/** Immediately reveals every unit and clears every pending pause. */
export function completeRevealSession(plan: RevealPlan, restored = false): RevealSessionState {
  return makeState(plan, plan.completionMs, true, restored);
}

export function cancelRevealSession(state: RevealSessionState): RevealSessionState {
  if (state.status === "cancelled") return state;
  return { ...state, status: "cancelled", activePause: null };
}

/**
 * Immutable façade used by React controllers. Each operation returns a new
 * session, so a stale animation callback cannot mutate a newer prompt.
 */
export class TextRevealSession {
  readonly plan: RevealPlan;
  readonly state: RevealSessionState;

  constructor(options: TextRevealSessionOptions, state?: RevealSessionState) {
    this.plan = createRevealPlan(options);
    this.state = state ?? initialRevealSessionState(this.plan);
  }

  private static fromPlan(plan: RevealPlan, state: RevealSessionState): TextRevealSession {
    const session = Object.create(TextRevealSession.prototype) as TextRevealSession;
    Object.defineProperties(session, {
      plan: { value: plan, enumerable: true },
      state: { value: state, enumerable: true },
    });
    return session;
  }

  advance(deltaMs: number): TextRevealSession {
    return TextRevealSession.fromPlan(this.plan, advanceRevealSession(this.plan, this.state, deltaMs));
  }

  pause(): TextRevealSession {
    return TextRevealSession.fromPlan(this.plan, pauseRevealSession(this.plan, this.state));
  }

  resume(): TextRevealSession {
    return TextRevealSession.fromPlan(this.plan, resumeRevealSession(this.plan, this.state));
  }

  /** Completes the active reveal while preserving the current presentation. */
  completeReveal(): TextRevealSession {
    return TextRevealSession.fromPlan(this.plan, completeRevealSession(this.plan));
  }

  /** Restores a saved presentation directly at its final state. */
  restorePresentation(): TextRevealSession {
    return TextRevealSession.fromPlan(this.plan, completeRevealSession(this.plan, true));
  }

  cancel(): TextRevealSession {
    return TextRevealSession.fromPlan(this.plan, cancelRevealSession(this.state));
  }
}

function makeState(
  plan: RevealPlan,
  elapsedMs: number,
  forceComplete: boolean,
  restored: boolean,
): RevealSessionState {
  const elapsed = Math.max(0, Math.min(plan.completionMs, elapsedMs));
  const revealedUnitIndices: number[] = [];
  for (const event of plan.events) {
    if (forceComplete || event.atMs <= elapsed) revealedUnitIndices.push(event.revealIndex);
    else break;
  }
  const activePause = forceComplete ? null : pauseAt(plan.pauses, elapsed);
  const completed = forceComplete || elapsed >= plan.completionMs;
  return {
    status: completed ? "completed" : activePause !== null ? "waiting" : elapsed === 0 ? "preparing" : "revealing",
    elapsedMs: elapsed,
    revealedCount: revealedUnitIndices.length,
    revealedUnitIndices,
    activePause,
    completionMs: plan.completionMs,
    restored,
  };
}

function pauseAt(pauses: readonly PauseWindow[], elapsed: number): PauseWindow | null {
  for (const pause of pauses) if (elapsed >= pause.startMs && elapsed < pause.endMs) return pause;
  return null;
}

function shouldWaitForMath(unit: MathUnit, options: RevealTimingOptions): boolean {
  return unit.display || options.waitForInlineMath !== false;
}

function validCps(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
