import type { LucideIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Tip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  /** Trailing adornment such as a chevron or a keyboard hint. */
  trailing?: ReactNode;
}

/** Text button with an optional leading icon. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      icon: Icon,
      trailing,
      className,
      children,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <button
        {...rest}
        className={`vs-button vs-button-${variant} vs-button-${size}${className === undefined ? "" : ` ${className}`}`}
        ref={ref}
        type={type}
      >
        {Icon !== undefined && (
          <Icon aria-hidden="true" className="vs-button-icon" />
        )}
        {children !== undefined && (
          <span className="vs-button-label">{children}</span>
        )}
        {trailing}
      </button>
    );
  },
);

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  /** Accessible name; also the tooltip unless `tooltip` overrides it. */
  label: string;
  icon: LucideIcon;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Toggle state for tool buttons. */
  active?: boolean;
  tooltip?: ReactNode;
  shortcut?: string;
}

/** Square icon-only button; always labelled and always explained on hover. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon: Icon,
      variant = "ghost",
      size = "md",
      active,
      tooltip,
      shortcut,
      className,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <Tip content={tooltip ?? label} shortcut={shortcut}>
        <button
          {...rest}
          aria-label={label}
          aria-pressed={active}
          className={`vs-icon-button vs-button-${variant} vs-icon-button-${size}${active === true ? " is-active" : ""}${className === undefined ? "" : ` ${className}`}`}
          ref={ref}
          type={type}
        >
          <Icon aria-hidden="true" />
        </button>
      </Tip>
    );
  },
);
