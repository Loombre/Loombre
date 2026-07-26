// SPDX-License-Identifier: AGPL-3.0-only
import type { InputHTMLAttributes } from "react";
import { Icon } from "../icon/Icon.js";
import styles from "./Input.module.css";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  const { className, ...rest } = props;
  return <input className={[styles.input, className].filter(Boolean).join(" ")} {...rest} />;
}

export function SearchField(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <div className={styles.searchField}>
      <span className={styles.searchIcon}>
        <Icon icon="search" size="dense" />
      </span>
      <TextInput type="search" {...props} />
    </div>
  );
}
