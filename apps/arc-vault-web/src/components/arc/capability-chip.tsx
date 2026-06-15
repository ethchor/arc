import { cn } from "@/lib/utils";

export type Capability = "create" | "read" | "update" | "delete" | "list" | "sudo";

/**
 * A policy capability chip (create/read/update/delete/list/sudo), colour-coded by blast
 * radius. Ported from the arc design system (`security/CapabilityChip`). `deny` renders a
 * struck-through neutral chip; `active=false` dims it. Styling: `.arc-cap*`.
 */
export function CapabilityChip({
  capability,
  active = true,
  deny = false,
  onToggle,
  className,
}: {
  capability: Capability;
  active?: boolean;
  deny?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  const variant = deny ? "deny" : capability;
  return (
    <span
      className={cn(
        "arc-cap",
        `arc-cap--${variant}`,
        !active && "arc-cap--inactive",
        onToggle && "cursor-pointer hover:brightness-95",
        className,
      )}
      role={onToggle ? "button" : undefined}
      onClick={onToggle}
    >
      {capability}
    </span>
  );
}
