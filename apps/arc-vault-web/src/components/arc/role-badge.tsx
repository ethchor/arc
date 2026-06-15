import type { ComponentType } from "react";
import { Bot, Eye, KeyRound, Shield, User } from "lucide-react";
import { cn } from "@/lib/utils";

export type ArcRole = "owner" | "admin" | "editor" | "viewer" | "agent";

const ICONS: Record<ArcRole, ComponentType<{ className?: string }>> = {
  owner: KeyRound,
  admin: Shield,
  editor: User,
  viewer: Eye,
  agent: Bot,
};

/**
 * Role badge (owner / admin / editor / viewer / agent). Ported from the arc design
 * system (`security/RoleBadge`). Each role gets its own tint via `.arc-role--<role>`.
 */
export function RoleBadge({ role = "viewer", className }: { role?: string; className?: string }) {
  const safe = (["owner", "admin", "editor", "viewer", "agent"].includes(role) ? role : "viewer") as ArcRole;
  const Icon = ICONS[safe];
  return (
    <span className={cn("arc-role", `arc-role--${safe}`, className)}>
      <Icon className="h-3 w-3" />
      {role}
    </span>
  );
}
