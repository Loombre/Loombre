// SPDX-License-Identifier: AGPL-3.0-only
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  iconOnly?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "primary",
  iconOnly = false,
  className,
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={[styles.button, styles[variant], iconOnly ? styles.iconOnly : "", className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
