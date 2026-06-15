import type { ComponentType, ReactNode } from "react";
import { CheckCircle2, Lock, Shield, ShieldCheck, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

type Kind = "zk" | "pq" | "local" | "e2e" | "verified";

const PRESETS: Record<Kind, { icon: ComponentType<{ className?: string }>; text: string }> = {
  zk: { icon: ShieldCheck, text: "zero-knowledge" },
  pq: { icon: Zap, text: "post-quantum" },
  local: { icon: Lock, text: "encrypted on this device" },
  e2e: { icon: Shield, text: "end-to-end encrypted" },
  verified: { icon: CheckCircle2, text: "identity verified" },
};

/**
 * Persistent trust signal — "the server can't read this." Ported from the arc design
 * system (`security/TrustIndicator`). Truthful by design: only claims what's real
 * (server holds ciphertext; client holds keys). Styling: `.arc-trust*`.
 */
export function TrustIndicator({
  kind = "zk",
  children,
  variant = "default",
  size = "md",
  className,
}: {
  kind?: Kind;
  children?: ReactNode;
  variant?: "default" | "plain" | "solid";
  size?: "md" | "lg";
  className?: string;
}) {
  const preset = PRESETS[kind] ?? PRESETS.zk;
  const Icon = preset.icon;
  return (
    <span
      className={cn(
        "arc-trust",
        variant !== "default" && `arc-trust--${variant}`,
        size === "lg" && "arc-trust--lg",
        className,
      )}
    >
      <span className="arc-trust__icon">
        <Icon className={size === "lg" ? "h-3.5 w-3.5" : "h-3 w-3"} />
      </span>
      {children ?? preset.text}
    </span>
  );
}
