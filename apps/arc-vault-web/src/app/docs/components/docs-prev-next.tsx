import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { siblingsFor } from "./nav-config";

export function DocsPrevNext({ href }: { href: string }) {
  const { prev, next } = siblingsFor(href);
  if (!prev && !next) return null;
  return (
    <nav className="mt-10 flex items-stretch gap-3 border-t pt-6 text-sm">
      {prev ? (
        <Link
          href={prev.href}
          className="group flex flex-1 flex-col rounded-lg border bg-card p-3 transition-colors hover:border-primary/40"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowLeft className="h-3 w-3" />
            Previous
          </span>
          <span className="font-medium group-hover:text-primary">{prev.label}</span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
      {next ? (
        <Link
          href={next.href}
          className="group flex flex-1 flex-col items-end rounded-lg border bg-card p-3 text-right transition-colors hover:border-primary/40"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            Next
            <ArrowRight className="h-3 w-3" />
          </span>
          <span className="font-medium group-hover:text-primary">{next.label}</span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
    </nav>
  );
}
