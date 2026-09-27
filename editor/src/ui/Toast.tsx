import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  ToastContext,
  type ToastApi,
  type ToastOptions,
  type ToastTone,
} from "./feedbackContext";

interface ToastRecord extends ToastOptions {
  id: number;
  tone: ToastTone;
}

const ICONS: Record<ToastTone, LucideIcon> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
};

const MAX_TOASTS = 4;

/** Stacked, bottom-right notifications with per-tone persistence. */
export function ToastProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const show = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    const tone = options.tone ?? "info";
    setToasts((current) =>
      [...current, { ...options, id, tone }].slice(-MAX_TOASTS),
    );
    return id;
  }, []);
  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [dismiss, show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="vs-toast-viewport">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} onDismiss={dismiss} toast={toast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastRecord;
  onDismiss(id: number): void;
}): ReactElement {
  const duration =
    toast.duration !== undefined
      ? toast.duration
      : toast.tone === "error" || toast.tone === "warning"
        ? null
        : 4000;
  useEffect(() => {
    if (duration === null) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), duration);
    return () => window.clearTimeout(timer);
  }, [duration, onDismiss, toast.id]);
  const Icon = ICONS[toast.tone];
  return (
    <div
      className={`vs-toast vs-toast-${toast.tone}`}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" className="vs-toast-icon" />
      <div className="vs-toast-message">{toast.message}</div>
      {toast.action !== undefined && (
        <button
          className="vs-toast-action"
          onClick={() => {
            toast.action?.onAction();
            onDismiss(toast.id);
          }}
          type="button"
        >
          {toast.action.label}
        </button>
      )}
      <button
        aria-label="关闭通知"
        className="vs-toast-close"
        onClick={() => onDismiss(toast.id)}
        type="button"
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
