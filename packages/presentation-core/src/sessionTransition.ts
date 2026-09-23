import type { WireU64 } from "../../../shared/generated/WireU64";

export function requireSessionId(value: WireU64 | undefined): WireU64 {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("运行时未返回有效会话编号，请重新连接。");
  }
  // Session IDs are wire u64 values.  Keep this check at the UI boundary as
  // well as in Rust so a malformed response cannot become an unbounded
  // ledger key or accidentally compare equal after a lossy conversion.
  try {
    if (BigInt(value) > (1n << 64n) - 1n) throw new Error("超出 u64 范围");
  } catch {
    throw new Error("运行时未返回有效会话编号，请重新连接。");
  }
  return value;
}

/**
 * Guards asynchronous story/session commands against late completions.  A
 * command can outlive a React render (and even the session that started it),
 * so callers must capture a token and check it before applying *any* result,
 * error, or finally cleanup.
 */
export interface SessionTransitionToken {
  readonly id: number;
  readonly generation: number;
  readonly sessionId: WireU64;
}

export class SessionTransitionController {
  private nextId = 0;
  private activeId = 0;

  begin(generation: number, sessionId: WireU64): SessionTransitionToken {
    const token = { id: ++this.nextId, generation, sessionId };
    this.activeId = token.id;
    return token;
  }

  isCurrent(
    token: SessionTransitionToken,
    generation: number,
    sessionId: WireU64,
  ): boolean {
    return (
      token.id === this.activeId &&
      token.generation === generation &&
      token.sessionId === sessionId
    );
  }

  isCurrentGeneration(
    token: SessionTransitionToken,
    generation: number,
  ): boolean {
    return token.id === this.activeId && token.generation === generation;
  }

  invalidate(): void {
    this.activeId = ++this.nextId;
  }
}
