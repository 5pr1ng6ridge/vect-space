import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

import { Kbd } from "./Display";

/**
 * Hover/focus hint for a single interactive child.  Renders the child alone
 * when there is nothing to show, so it is cheap to wrap every icon button.
 */
export function Tip({
  children,
  content,
  shortcut,
  side = "bottom",
}: {
  children: ReactElement;
  content: ReactNode;
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
}): ReactElement {
  if (content === undefined || content === null || content === "")
    return children;
  return (
    // Each Tip carries its own provider, so any component can use tooltips
    // without an App-level wrapper (and leaf component tests stay simple).
    <TooltipPrimitive.Provider delayDuration={450} skipDelayDuration={150}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="vs-tooltip"
            collisionPadding={8}
            side={side}
            sideOffset={6}
          >
            <span>{content}</span>
            {shortcut !== undefined && <Kbd>{shortcut}</Kbd>}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
