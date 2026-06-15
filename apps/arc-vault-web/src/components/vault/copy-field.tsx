"use client";

import { CopyButton } from "@/components/arc/copy-button";
import { MaskedField } from "@/components/arc/masked-field";

/**
 * Labelled copy/reveal row for a single item field. Secret fields render the arc design
 * system's MaskedField (masked-by-default, reveal + copy with clipboard auto-clear and the
 * "held in memory only" note); non-secret fields show the value with a copy button.
 *
 * Same public API as before (`label` / `value` / `secret`) so every call site is untouched
 * — this is presentation only; the value still arrives post-decryption (ADR-002).
 */
export function CopyField({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      {secret ? (
        <MaskedField value={value} />
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-md border border-input bg-[var(--surface-inset)] px-3 py-2">
          <span className="min-w-0 truncate font-mono text-sm">{value || "—"}</span>
          <CopyButton value={value} iconOnly />
        </div>
      )}
    </div>
  );
}
