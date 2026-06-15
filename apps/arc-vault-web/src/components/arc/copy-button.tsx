"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Copy → confirm → clipboard auto-clear countdown. Ported from the arc design system
 * (`security/CopyButton`). When `autoClearSeconds > 0`, the value is wiped from the
 * clipboard after the countdown — surfaced as a live `0:NN` timer — so a copied secret
 * doesn't linger. Styling: `.arc-copy*` in globals.css.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  autoClearSeconds = 20,
  iconOnly = false,
  onCopy,
  className,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  autoClearSeconds?: number;
  iconOnly?: boolean;
  onCopy?: (value: string) => void;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const [left, setLeft] = React.useState(0);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  React.useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const handle = async () => {
    try {
      await navigator.clipboard?.writeText(String(value));
    } catch {
      /* clipboard can fail in non-secure contexts; visual stays at "Copy" */
    }
    onCopy?.(value);
    setCopied(true);
    if (autoClearSeconds > 0) {
      setLeft(autoClearSeconds);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(() => {
        setLeft((n) => {
          if (n <= 1) {
            if (timer.current) clearInterval(timer.current);
            navigator.clipboard?.writeText("").catch(() => {});
            setCopied(false);
            return 0;
          }
          return n - 1;
        });
      }, 1000);
    } else {
      setTimeout(() => setCopied(false), 1400);
    }
  };

  const countdown = `0:${String(left).padStart(2, "0")}`;

  return (
    <button
      type="button"
      className={cn("arc-copy", copied && "arc-copy--done", iconOnly && "arc-copy--icon", className)}
      onClick={handle}
      aria-label={copied ? copiedLabel : label}
      title={copied && autoClearSeconds > 0 ? `Clears in ${countdown}` : label}
    >
      {copied ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}
      {!iconOnly && <span>{copied ? copiedLabel : label}</span>}
      {!iconOnly && copied && autoClearSeconds > 0 && <span className="arc-copy__count">{countdown}</span>}
    </button>
  );
}
