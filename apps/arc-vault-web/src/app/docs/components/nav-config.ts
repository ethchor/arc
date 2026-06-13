/**
 * Docs sidebar nav config — one source of truth for the sidebar and any future
 * breadcrumb / prev-next widget. Keep section order = display order.
 */
export interface DocsNavLink {
  label: string;
  href: string;
  badge?: string;
}

export interface DocsNavSection {
  label: string;
  items: DocsNavLink[];
}

export const docsNav: DocsNavSection[] = [
  {
    label: "Get started",
    items: [
      { label: "Overview", href: "/docs" },
      { label: "Quick start", href: "/docs/getting-started" },
    ],
  },
  {
    label: "Concepts",
    items: [
      { label: "Architecture", href: "/docs/architecture", badge: "diagram" },
    ],
  },
  {
    label: "Engines",
    items: [
      { label: "Engine A — infra secrets", href: "/docs/engines/engine-a" },
      { label: "Engine B — E2E vault", href: "/docs/engines/engine-b" },
      { label: "Engine C — agents", href: "/docs/engines/engine-c" },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "Environment variables", href: "/docs/reference/env-vars" },
      { label: "API surface", href: "/docs/reference/api" },
    ],
  },
];

/** Flat list (for prev / next widgets). */
export const docsFlat: DocsNavLink[] = docsNav.flatMap((s) => s.items);

export function siblingsFor(href: string) {
  const i = docsFlat.findIndex((l) => l.href === href);
  return {
    prev: i > 0 ? docsFlat[i - 1] : undefined,
    next: i >= 0 && i < docsFlat.length - 1 ? docsFlat[i + 1] : undefined,
  };
}
