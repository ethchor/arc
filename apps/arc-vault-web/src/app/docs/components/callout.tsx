import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Lightbulb, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

type Kind = "info" | "tip" | "warning" | "danger" | "success";

const styles: Record<Kind, { wrap: string; icon: ReactNode; label: string }> = {
  info: {
    wrap: "border-blue-500/30 bg-blue-500/5 text-foreground",
    icon: <Info className="h-4 w-4 text-blue-500" />,
    label: "Note",
  },
  tip: {
    wrap: "border-emerald-500/30 bg-emerald-500/5",
    icon: <Lightbulb className="h-4 w-4 text-emerald-500" />,
    label: "Tip",
  },
  warning: {
    wrap: "border-amber-500/30 bg-amber-500/5",
    icon: <AlertTriangle className="h-4 w-4 text-amber-500" />,
    label: "Warning",
  },
  danger: {
    wrap: "border-red-500/30 bg-red-500/5",
    icon: <ShieldAlert className="h-4 w-4 text-red-500" />,
    label: "Danger",
  },
  success: {
    wrap: "border-emerald-500/30 bg-emerald-500/5",
    icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
    label: "Verified",
  },
};

export function Callout({
  kind = "info",
  title,
  children,
}: {
  kind?: Kind;
  title?: string;
  children: ReactNode;
}) {
  const s = styles[kind];
  return (
    <div className={cn("my-4 rounded-lg border-l-4 p-4 text-sm", s.wrap)}>
      <div className="mb-1 flex items-center gap-2 font-medium">
        {s.icon}
        <span className="capitalize">{title ?? s.label}</span>
      </div>
      <div className="text-foreground/85 [&>p]:my-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
        {children}
      </div>
    </div>
  );
}
