/**
 * Contexts for app-wide feedback: toasts and confirmations.  Kept apart from
 * the provider components so both files satisfy react-refresh.
 */
import { createContext, useContext, type ReactNode } from "react";

export type ToastTone = "success" | "info" | "warning" | "error";

export interface ToastOptions {
  tone?: ToastTone;
  message: ReactNode;
  /** Optional one-click follow-up such as 撤销 or 定位. */
  action?: { label: string; onAction(): void };
  /**
   * Milliseconds before auto-dismiss; `null` keeps the toast until closed.
   * Defaults: errors and warnings stay, everything else fades after 4s.
   */
  duration?: number | null;
}

export interface ToastApi {
  show(options: ToastOptions): number;
  dismiss(id: number): void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error("useToast 需要在 ToastProvider 内使用");
  return api;
}

export interface ConfirmOptions {
  title: string;
  /** What will happen, in plain words. */
  description?: ReactNode;
  /** The consequence-naming action label, e.g. 「删除 3 个节点」. */
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

export const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Native fallback for components rendered outside the App shell. */
const nativeConfirm: ConfirmFn = (options) =>
  Promise.resolve(window.confirm(options.title));

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? nativeConfirm;
}
