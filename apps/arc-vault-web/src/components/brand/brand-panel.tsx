import type { ComponentType } from "react";
import { Bot, ShieldCheck, Zap } from "lucide-react";
import { TrustIndicator } from "@/components/arc/trust-indicator";

/**
 * The signature onboarding/lock brand panel from the arc design system: the honeycomb
 * halftone mark over a control-room-dark field. Always dark (independent of the app
 * theme). Two variants, matching the design:
 *   - "enroll"  — "One account. Two worlds of secrets." + the three feature rows.
 *   - "unlock"  — "A vault you actually enjoy using." (calmer, no feature list).
 *
 * The honeycomb (`/arc-honeycomb.svg`) renders via CSS `mask` so it tints to arc cyan and
 * the 35 KB SVG stays out of the JS bundle. Hidden below `md` (768px) by the caller —
 * matches the design system's 820px collapse point so anything wider than a phone shows
 * the split layout.
 */
const FEATURES: { icon: ComponentType<{ className?: string }>; title: string; desc: string }[] = [
  { icon: ShieldCheck, title: "Zero-knowledge", desc: "The server only ever holds ciphertext — your keys never leave this device." },
  { icon: Zap, title: "Post-quantum", desc: "Vault keys are shared with a hybrid X25519 + ML-KEM-768 scheme." },
  { icon: Bot, title: "Humans & machines", desc: "One identity governs you, your team, CI, and AI agents alike." },
];

const HONEYCOMB_MASK = {
  WebkitMask: "url(/arc-honeycomb.svg) center / contain no-repeat",
  mask: "url(/arc-honeycomb.svg) center / contain no-repeat",
} as const;

export function BrandPanel({ variant = "enroll" }: { variant?: "enroll" | "unlock" }) {
  return (
    <aside className="arc-grid-bg relative hidden flex-col justify-center overflow-hidden bg-[#0C0F16] p-10 text-[#E9ECF1] md:flex lg:p-14">
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 18% 8%, rgba(236,155,46,0.10), transparent 60%), radial-gradient(ellipse 80% 60% at 85% 100%, rgba(45,198,177,0.16), transparent 62%)",
        }}
      />

      <div className="relative flex flex-col items-start gap-5">
        <span aria-hidden className="h-24 w-24 bg-[#2DC6B1] lg:h-28 lg:w-28" style={HONEYCOMB_MASK} />
        {variant === "enroll" ? (
          <>
            <h2 className="font-display text-3xl font-medium leading-[1.1] tracking-tight lg:text-[34px]">
              One account.
              <br />
              Two worlds of secrets.
            </h2>
            <p className="max-w-[34ch] text-sm leading-relaxed text-[#9AA4B4]">
              arc spans your personal vault and your team&apos;s infrastructure secrets — under
              one key only you hold.
            </p>
            <div className="mt-1 flex flex-col gap-3.5">
              {FEATURES.map((f) => (
                <div key={f.title} className="flex max-w-[36ch] items-start gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--ds-accent-subtle)] text-[var(--ds-accent-subtle-fg)]">
                    <f.icon className="h-[17px] w-[17px]" />
                  </span>
                  <div>
                    <div className="text-[13px] font-semibold text-[#E9ECF1]">{f.title}</div>
                    <div className="mt-0.5 text-xs leading-snug text-[#9AA4B4]">{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <h2 className="max-w-[16ch] font-display text-3xl font-medium leading-[1.1] tracking-tight lg:text-4xl">
              A vault you actually enjoy using.
            </h2>
            <p className="max-w-[40ch] text-sm leading-relaxed text-[#9AA4B4]">
              One key, held only by you, spans your passwords and your infrastructure secrets.
            </p>
          </>
        )}

        {/* Trust badges flow naturally beneath the content (same left edge as the
            features), with a generous gap above. Beats absolute-positioning, which
            on a tall viewport leaves a yawning empty band between content + badges. */}
        <div className="mt-2 flex flex-wrap gap-2">
          <TrustIndicator kind="zk" />
          <TrustIndicator kind="pq" />
        </div>
      </div>
    </aside>
  );
}
