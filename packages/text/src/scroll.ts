/**
 * State for the long-text scroll follower.  The controller is deliberately
 * renderer agnostic so the game and editor use identical motion math.
 */
export interface LongTextScrollState {
  readonly position: number;
  readonly target: number;
  readonly velocity: number;
  readonly settled: boolean;
}

export interface LongTextScrollControllerOptions {
  readonly position?: number;
  readonly target?: number;
  readonly maxScroll?: number;
}

const POSITION_EPSILON = 0.1;
const VELOCITY_EPSILON = 1;

/**
 * Analytic critically-damped follower.  Since each step is solved from the
 * current position and velocity, changing the target never throws away the
 * momentum accumulated by the previous target.
 */
export class LongTextScrollController {
  private position: number;
  private target: number;
  private velocity = 0;
  private maxScroll: number;

  constructor(options: LongTextScrollControllerOptions = {}) {
    this.maxScroll = safeBound(options.maxScroll ?? 0);
    this.position = clamp(options.position ?? 0, 0, this.maxScroll);
    this.target = clamp(options.target ?? this.position, 0, this.maxScroll);
  }

  getState(): LongTextScrollState {
    return {
      position: this.position,
      target: this.target,
      velocity: this.velocity,
      settled: this.isSettled(),
    };
  }

  setBounds(maxScroll: number): LongTextScrollState {
    this.maxScroll = safeBound(maxScroll);
    this.position = clamp(this.position, 0, this.maxScroll);
    this.target = clamp(this.target, 0, this.maxScroll);
    this.stopOutwardVelocityAtBounds();
    return this.getState();
  }

  setTarget(target: number): LongTextScrollState {
    this.target = clamp(target, 0, this.maxScroll);
    this.stopOutwardVelocityAtBounds();
    return this.getState();
  }

  /** Direct manipulation, used by wheel and pointer browsing. */
  setPosition(position: number, preserveVelocity = false): LongTextScrollState {
    this.position = clamp(position, 0, this.maxScroll);
    if (!preserveVelocity) this.velocity = 0;
    this.stopOutwardVelocityAtBounds();
    return this.getState();
  }

  /** Advances by at most one rendered frame and returns the new state. */
  advance(elapsedMs: number, fastForward = false): LongTextScrollState {
    const seconds = Math.min(50, Math.max(0, elapsedMs)) / 1_000;
    if (seconds <= 0) return this.getState();

    const omega = fastForward ? 32 : 14;
    const offset = this.position - this.target;
    const initialVelocity = this.velocity;
    const decay = Math.exp(-omega * seconds);
    const nextOffset =
      (offset + (initialVelocity + omega * offset) * seconds) * decay;
    const nextVelocity =
      (initialVelocity - omega * (initialVelocity + omega * offset) * seconds) *
      decay;
    this.position = clamp(this.target + nextOffset, 0, this.maxScroll);
    this.velocity = nextVelocity;
    if (this.position === 0 || this.position === this.maxScroll) {
      this.stopOutwardVelocityAtBounds();
    }
    if (this.isSettled()) {
      this.position = this.target;
      this.velocity = 0;
    }
    return this.getState();
  }

  isSettled(): boolean {
    return (
      Math.abs(this.target - this.position) <= POSITION_EPSILON &&
      Math.abs(this.velocity) < VELOCITY_EPSILON
    );
  }

  private stopOutwardVelocityAtBounds(): void {
    if (this.position <= 0 && this.velocity < 0) this.velocity = 0;
    if (this.position >= this.maxScroll && this.velocity > 0) {
      this.velocity = 0;
    }
  }
}

function safeBound(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
