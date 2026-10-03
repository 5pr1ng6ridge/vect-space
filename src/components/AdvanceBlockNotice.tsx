import type { ReactElement } from "react";

import { MarkupText } from "@vectspace/presentation-react/gameplay";

/**
 * The hint a script gave for "the story cannot be turned right now".
 *
 * It is information only: choices, other buttons and the text reveal itself
 * keep working underneath, and the notice never takes pointer input.  The
 * messages are already interpolated by the runtime, so a variable or window
 * title they mention stays current without any work here.
 */
export function AdvanceBlockNotice({
  messages,
}: {
  messages: readonly string[];
}): ReactElement | null {
  if (messages.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="advance-block-notice"
      data-testid="advance-block-notice"
      role="status"
    >
      {messages.map((message) => (
        <p key={message}>
          <MarkupText source={message} />
        </p>
      ))}
    </div>
  );
}
