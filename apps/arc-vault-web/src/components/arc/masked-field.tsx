"use client";

import * as React from "react";
import { Eye, EyeOff, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

/**
 * Masked secret value with reveal/conceal + copy. Ported from the arc design system
 * (`security/MaskedField`). Masked by default; revealing flips to a warm "revealed" plate
 * and shows the "held in memory only" note. Copy goes through {@link CopyButton} so a
 * revealed-then-copied secret still auto-clears the clipboard. Styling: `.arc-masked*`.
 */
export function MaskedField({
  value,
  revealedByDefault = false,
  dots = 12,
  copyable = true,
  autoClearSeconds = 20,
  note = "held in memory only — never sent to arc",
  className,
}: {
  value: string;
  revealedByDefault?: boolean;
  dots?: number;
  copyable?: boolean;
  autoClearSeconds?: number;
  note?: string;
  className?: string;
}) {
  const [revealed, setRevealed] = React.useState(revealedByDefault);
  return (
    <div className="arc-masked-wrap">
      <div className={cn("arc-masked", revealed && "arc-masked--revealed", className)}>
        <span className="arc-masked__val">
          {revealed ? (
            value
          ) : (
            <span className="arc-masked__dots" aria-label="hidden value">
              {"•".repeat(dots)}
            </span>
          )}
        </span>
        <span className="arc-masked__actions">
          <button
            type="button"
            className="arc-copy arc-copy--icon"
            aria-label={revealed ? "Hide" : "Reveal"}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          {copyable && <CopyButton value={value} iconOnly autoClearSeconds={autoClearSeconds} />}
        </span>
      </div>
      {revealed && note ? (
        <span className="arc-masked__tag">
          <Shield className="h-3 w-3" /> {note}
        </span>
      ) : null}
    </div>
  );
}
