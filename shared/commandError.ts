import type {
  WireCommandError,
  WireCommandErrorCode,
  WireStoryLocation,
} from "./generated";

const ERROR_CODES: readonly WireCommandErrorCode[] = [
  "validation",
  "stale_project",
  "stale_session",
  "io",
  "asset",
  "preview_unreachable",
  "runtime",
  "internal",
];

/** A typed error from a Tauri command, preserving location metadata. */
export class CommandError extends Error {
  readonly code: WireCommandErrorCode;
  readonly path: string | undefined;
  readonly location: WireStoryLocation | undefined;
  readonly elementId: string | undefined;

  constructor(detail: WireCommandError) {
    super(detail.message);
    this.name = "CommandError";
    this.code = detail.code;
    this.path = detail.path ?? undefined;
    this.location = detail.location ?? undefined;
    this.elementId = detail.element_id ?? undefined;
  }
}

function isWireCommandError(value: unknown): value is WireCommandError {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.message === "string" &&
    typeof record.code === "string" &&
    ERROR_CODES.includes(record.code as WireCommandErrorCode)
  );
}

/** Normalize WebView invoke rejections without throwing away structured data. */
export function toCommandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (isWireCommandError(error)) return new CommandError(error);
  if (error instanceof Error) {
    return new CommandError({
      code: "internal",
      message: error.message,
      path: null,
      location: null,
      element_id: null,
    });
  }
  if (typeof error === "string") {
    return new CommandError({
      code: "internal",
      message: error,
      path: null,
      location: null,
      element_id: null,
    });
  }
  return new CommandError({
    code: "internal",
    message: "Tauri 命令返回了无法识别的错误",
    path: null,
    location: null,
    element_id: null,
  });
}
