import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function FeatureCard({
  icon,
  title,
  href,
  children,
  className,
}: {
  icon?: ReactNode;
  title: string;
  href?: string;
  children: ReactNode;
  className?: string;
}) {
  const inner = (
    <>
      <div className="mb-3 flex items-center gap-3">
        {icon ? (
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
            {icon}
          </span>
        ) : null}
        <h3 className="font-semibold leading-none tracking-tight">{title}</h3>
      </div>
      <div className="text-sm text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground">
        {children}
      </div>
      {href ? (
        <div className="mt-4 flex items-center gap-1 text-sm font-medium text-primary opacity-80 transition-opacity group-hover:opacity-100">
          Read more
          <ArrowRight className="h-3.5 w-3.5" />
        </div>
      ) : null}
    </>
  );

  const base = cn(
    "group block rounded-xl border bg-card p-5 shadow-sm transition-all",
    href && "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
    className,
  );

  return href ? (
    <Link href={href} className={base}>
      {inner}
    </Link>
  ) : (
    <div className={base}>{inner}</div>
  );
}
