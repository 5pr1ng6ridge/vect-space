import type { ReactElement, ReactNode } from "react";

import { ConfirmProvider } from "../ui/Dialog";
import { ToastProvider } from "../ui/Toast";

/** App-wide feedback services: confirmations and toasts. */
export function AppProviders({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  );
}
