import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { TrustIndicator } from "@/components/arc/trust-indicator";

/**
 * Placeholder for arc-console screens that exist in the design system but aren't yet wired
 * to a real backend surface (KV browser, Transit, PKI, dynamic creds, persona Home, the
 * security dashboard). Renders the real page header + an honest "designed, wiring next"
 * note so the IA is complete and navigable without faking data.
 */
export function PreviewScreen({
  eyebrow,
  title,
  description,
  icon: Icon,
  engine,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  engine?: string;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {eyebrow}
        </span>
        <h1 className="font-display text-2xl font-medium tracking-tight">{title}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      </div>

      <Card tone="flat" className="border-dashed">
        <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
            <Icon className="h-5 w-5" />
          </span>
          <div>
            <p className="flex items-center justify-center gap-1.5 text-sm font-semibold">
              <Sparkles className="h-3.5 w-3.5 text-primary" /> Designed — wiring next
            </p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              This screen is part of the arc design system{engine ? ` (${engine})` : ""}. The
              visual surface is approved; it lands in an upcoming wave once its engine API is
              connected. Existing functional screens are unaffected.
            </p>
          </div>
          {engine ? <TrustIndicator kind="zk" /> : null}
        </CardContent>
      </Card>
    </div>
  );
}
