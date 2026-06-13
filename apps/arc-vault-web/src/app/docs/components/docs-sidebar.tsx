"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { docsNav } from "./nav-config";

export function DocsSidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav className={cn("space-y-6 text-sm", className)} aria-label="Docs navigation">
      {docsNav.map((section) => (
        <div key={section.label}>
          <h4 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {section.label}
          </h4>
          <ul className="space-y-1">
            {section.items.map((item) => {
              const active =
                pathname === item.href ||
                (item.href !== "/docs" && pathname?.startsWith(item.href + "/"));
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "group flex items-center justify-between rounded-md px-2 py-1.5 transition-colors",
                      active
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-foreground/80 hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <span>{item.label}</span>
                    {item.badge ? (
                      <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent-foreground group-hover:bg-background">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
