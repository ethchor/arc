import { cn } from "@/lib/utils";

const LEVELS = [
  { label: "Too weak", color: "var(--danger)" },
  { label: "Weak", color: "var(--danger)" },
  { label: "Fair", color: "var(--warning)" },
  { label: "Strong", color: "hsl(var(--primary))" },
  { label: "Excellent", color: "var(--success)" },
];

/**
 * Password-strength meter (0-4) with a segmented bar + crack-time line. Ported from the
 * arc design system (`security/PasswordStrength`). Presentation only — the caller scores
 * the password (e.g. zxcvbn). Styling: `.arc-pwstr*`.
 */
export function PasswordStrength({
  score = 0,
  segments = 4,
  crackTime,
  className,
}: {
  score?: number;
  segments?: number;
  crackTime?: string;
  className?: string;
}) {
  const s = Math.max(0, Math.min(4, score));
  const lvl = LEVELS[s]!;
  const filled = Math.ceil((s / 4) * segments);
  return (
    <div className={cn("arc-pwstr", className)}>
      <div className="arc-pwstr__bars">
        {Array.from({ length: segments }).map((_, i) => (
          <span
            key={i}
            className="arc-pwstr__seg"
            style={{ background: i < filled ? lvl.color : undefined }}
          />
        ))}
      </div>
      <div className="arc-pwstr__meta">
        <span className="arc-pwstr__label" style={{ color: lvl.color }}>
          {lvl.label}
        </span>
        {crackTime ? <span className="arc-pwstr__crack">~{crackTime} to crack · Argon2id</span> : null}
      </div>
    </div>
  );
}
