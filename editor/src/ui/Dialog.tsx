import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  useCallback,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { Button } from "./Button";
import {
  ConfirmContext,
  type ConfirmFn,
  type ConfirmOptions,
} from "./feedbackContext";

/**
 * Modal dialog: focus is trapped, Esc and the backdrop close it, and the
 * title names it for assistive technology.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  initialFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Element to focus on open instead of the first focusable one. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}): ReactElement {
  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="vs-dialog-overlay" />
        <DialogPrimitive.Content
          // Without a description Radix wants the attribute explicitly unset.
          {...(description === undefined
            ? { "aria-describedby": undefined }
            : {})}
          className={`vs-dialog vs-dialog-${size}`}
          onOpenAutoFocus={(event) => {
            if (initialFocus?.current == null) return;
            event.preventDefault();
            initialFocus.current.focus();
          }}
        >
          <header className="vs-dialog-header">
            <DialogPrimitive.Title className="vs-dialog-title">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button
                aria-label="关闭"
                className="vs-dialog-close"
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </DialogPrimitive.Close>
          </header>
          {description !== undefined && (
            <DialogPrimitive.Description className="vs-dialog-description">
              {description}
            </DialogPrimitive.Description>
          )}
          {children !== undefined && (
            <div className="vs-dialog-body">{children}</div>
          )}
          {footer !== undefined && (
            <footer className="vs-dialog-footer">{footer}</footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

interface PendingConfirm extends ConfirmOptions {
  resolve(value: boolean): void;
}

/**
 * Provides `useConfirm()`: a promise-based replacement for window.confirm
 * whose buttons name the consequence of the action.
 */
export function ConfirmProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setPending((current) => {
          current?.resolve(false);
          return { ...options, resolve };
        });
      }),
    [],
  );
  const settle = (value: boolean): void => {
    pending?.resolve(value);
    setPending(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        description={pending?.description}
        footer={
          <>
            <Button onClick={() => settle(false)} variant="ghost">
              {pending?.cancelLabel ?? "取消"}
            </Button>
            <Button
              onClick={() => settle(true)}
              ref={confirmRef}
              variant={pending?.danger === true ? "danger" : "primary"}
            >
              {pending?.confirmLabel}
            </Button>
          </>
        }
        initialFocus={confirmRef}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
        open={pending !== null}
        size="sm"
        title={pending?.title ?? ""}
      />
    </ConfirmContext.Provider>
  );
}
