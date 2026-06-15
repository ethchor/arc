import { TrustIndicator } from "@/components/arc/trust-indicator";

/**
 * The signature onboarding/lock brand panel from the arc design system: the honeycomb
 * halftone mark over a control-room-dark field, the "two worlds of secrets" headline,
 * and the truthful trust badges. Always dark (independent of the app theme), so it reads
 * as the brand's control-room regardless of light/dark.
 *
 * The honeycomb (`/arc-honeycomb.svg`) is rendered via CSS `mask` so it tints to arc cyan
 * and the 35 KB SVG stays out of the JS bundle. Hidden below `lg` by the caller; pair it
 * with the form column in a 2-up grid.
 */
export function BrandPanel() {
  return (
    <aside className="arc-grid-bg relative hidden flex-col justify-between overflow-hidden bg-[#0C0F16] p-10 text-[#E9ECF1] lg:flex xl:p-14">
      {/* ambient ember → cyan glow */}
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 18% 8%, rgba(236,155,46,0.10), transparent 60%), radial-gradient(ellipse 80% 60% at 85% 100%, rgba(45,198,177,0.16), transparent 62%)",
        }}
      />

      <div className="relative flex items-center gap-2.5">
        <span
          aria-hidden
          className="h-7 w-7 bg-[#2DC6B1]"
          style={{
            WebkitMask: "url(/arc-honeycomb.svg) center / contain no-repeat",
            mask: "url(/arc-honeycomb.svg) center / contain no-repeat",
          }}
        />
        <span className="font-display text-[17px] font-medium tracking-tight">arc</span>
      </div>

      <div className="relative flex flex-col items-start gap-6">
        <span
          aria-hidden
          className="h-32 w-32 bg-[#2DC6B1] xl:h-40 xl:w-40"
          style={{
            WebkitMask: "url(/arc-honeycomb.svg) center / contain no-repeat",
            mask: "url(/arc-honeycomb.svg) center / contain no-repeat",
          }}
        />
        <h2 className="max-w-[18ch] font-display text-3xl font-medium leading-tight tracking-tight xl:text-4xl">
          One account. Two worlds of secrets.
        </h2>
        <p className="max-w-[42ch] text-sm leading-relaxed text-[#9AA4B4]">
          Infrastructure secrets and an end-to-end-encrypted vault — under one identity,
          one policy engine, and one audit trail. The server stores ciphertext only.
        </p>
      </div>

      <div className="relative flex flex-wrap gap-2">
        <TrustIndicator kind="zk" />
        <TrustIndicator kind="pq" />
        <TrustIndicator kind="e2e" />
      </div>
    </aside>
  );
}
