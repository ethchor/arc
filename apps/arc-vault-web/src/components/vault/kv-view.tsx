"use client";

import * as React from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  FileClock,
  FileText,
  GitBranch,
  History,
  Info,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { IconTip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/arc/copy-button";
import { MaskedField } from "@/components/arc/masked-field";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { cn } from "@/lib/utils";

/**
 * Operator KV (v2) browser — implements the arc-console design-kit operator screen
 * (Engine A · Infrastructure → "KV secrets"). Left rail is a search + path tree;
 * right pane has the path hero plus three tabs: Current, Versions, Metadata. Versions
 * carry soft-delete / undelete / destroy actions and a diff against the previous
 * version.
 *
 * Preview only. The OpenBao KV engine adapter exists server-side but is not yet
 * exposed to the web client, so this view runs against a small mock dataset embedded
 * below — wide enough to demonstrate every status (current, soft-deleted, destroyed)
 * and the diff/undelete flows. When the engine API lands, swap `INITIAL_DATA` for a
 * fetched store and the same callbacks back the network mutations.
 */

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

type KvVersion = {
  version: number;
  data: Record<string, string>;
  createdAt: string; // ISO
  createdBy: string;
  deletedAt?: string;
  destroyed?: boolean;
};

type KvSecret = {
  path: string; // e.g. "app/prod/db" (mount prefix stripped)
  versions: KvVersion[]; // sorted desc by version — invariant: at least one entry
  metadata: {
    maxVersions: number;
    casRequired: boolean;
    customMetadata: Record<string, string>;
    createdAt: string;
    updatedAt: string;
  };
};

type TabKey = "current" | "versions" | "metadata";

// ────────────────────────────────────────────────────────────────────────────────
// Mock data — single mount, varied statuses
// ────────────────────────────────────────────────────────────────────────────────

const MOUNT = "secret/";

const INITIAL_DATA: KvSecret[] = [
  {
    path: "app/prod/db",
    versions: [
      {
        version: 3,
        data: {
          POSTGRES_URL: "postgres://app:r0t8d-Hjk2@db-prod.arc.internal:5432/app",
          REDIS_URL: "rediss://:Vr9q-2KdM@cache-prod.arc.internal:6380/0",
          RW_PASSWORD: "Hkq-3pLwTeR-9xZ",
        },
        createdAt: "2026-06-14T09:14:00Z",
        createdBy: "automation@arc",
      },
      {
        version: 2,
        data: {
          POSTGRES_URL: "postgres://app:8wK-x2RmN@db-prod.arc.internal:5432/app",
          REDIS_URL: "rediss://:Vr9q-2KdM@cache-prod.arc.internal:6380/0",
          RW_PASSWORD: "X3q-9zLmRpC-7tH",
        },
        createdAt: "2026-05-27T18:42:00Z",
        createdBy: "ethan@arc",
      },
      {
        version: 1,
        data: {
          POSTGRES_URL: "postgres://app:legacy@db-prod.arc.internal:5432/app",
          REDIS_URL: "rediss://:legacy@cache-prod.arc.internal:6380/0",
        },
        createdAt: "2026-04-02T11:09:00Z",
        createdBy: "ethan@arc",
      },
    ],
    metadata: {
      maxVersions: 10,
      casRequired: true,
      customMetadata: { owner: "platform", rotation: "weekly" },
      createdAt: "2026-04-02T11:09:00Z",
      updatedAt: "2026-06-14T09:14:00Z",
    },
  },
  {
    path: "app/prod/api",
    versions: [
      {
        version: 2,
        data: {
          STRIPE_KEY: "sk_live_51N0v3rR9-7QkLmZ-8H2c3D4f5G6h7J8k9L0m",
          SENDGRID_KEY: "SG.aB1cD2eF3-gH4iJ5kL6mN7oP8qR9s",
        },
        createdAt: "2026-06-10T15:01:00Z",
        createdBy: "automation@arc",
      },
      {
        version: 1,
        data: { STRIPE_KEY: "sk_live_initial_50W3Lm-9KrXn-4P2c3D" },
        createdAt: "2026-05-13T08:22:00Z",
        createdBy: "ethan@arc",
      },
    ],
    metadata: {
      maxVersions: 10,
      casRequired: false,
      customMetadata: { owner: "platform" },
      createdAt: "2026-05-13T08:22:00Z",
      updatedAt: "2026-06-10T15:01:00Z",
    },
  },
  {
    path: "app/staging/db",
    versions: [
      {
        version: 1,
        data: {
          POSTGRES_URL: "postgres://app:K2-x9LpQrM@db-stg.arc.internal:5432/app",
          REDIS_URL: "rediss://:K2-x9LpQrM@cache-stg.arc.internal:6380/0",
        },
        createdAt: "2026-06-13T10:00:00Z",
        createdBy: "ethan@arc",
      },
    ],
    metadata: {
      maxVersions: 5,
      casRequired: false,
      customMetadata: { owner: "platform" },
      createdAt: "2026-06-13T10:00:00Z",
      updatedAt: "2026-06-13T10:00:00Z",
    },
  },
  {
    path: "ops/oncall",
    versions: [
      {
        version: 5,
        data: {
          PAGERDUTY_TOKEN: "u+2K3rL-9xMnP-4qHj-7vBcW-3pZmK",
          SLACK_WEBHOOK: "https://hooks.slack.com/services/T0000/B0000/aB1cD2eF3gH4iJ5kL6",
        },
        createdAt: "2026-06-17T03:30:00Z",
        createdBy: "automation@arc",
      },
      {
        version: 4,
        data: { PAGERDUTY_TOKEN: "u+legacy-rotation-2026-06-17a" },
        createdAt: "2026-06-17T03:00:00Z",
        createdBy: "ethan@arc",
        deletedAt: "2026-06-17T03:30:00Z",
      },
      {
        version: 3,
        data: { PAGERDUTY_TOKEN: "u+rotation-2026-06-10" },
        createdAt: "2026-06-10T09:00:00Z",
        createdBy: "automation@arc",
      },
      {
        version: 2,
        data: { PAGERDUTY_TOKEN: "u+rotation-2026-06-03" },
        createdAt: "2026-06-03T09:00:00Z",
        createdBy: "automation@arc",
      },
      {
        version: 1,
        data: { PAGERDUTY_TOKEN: "u+rotation-2026-05-27" },
        createdAt: "2026-05-27T09:00:00Z",
        createdBy: "ethan@arc",
      },
    ],
    metadata: {
      maxVersions: 5,
      casRequired: true,
      customMetadata: { owner: "ops", rotation: "weekly" },
      createdAt: "2026-05-27T09:00:00Z",
      updatedAt: "2026-06-17T03:30:00Z",
    },
  },
  {
    path: "ops/legacy",
    versions: [
      {
        version: 1,
        data: { TOKEN: "(destroyed)" },
        createdAt: "2024-11-08T12:00:00Z",
        createdBy: "ethan@arc",
        destroyed: true,
      },
    ],
    metadata: {
      maxVersions: 1,
      casRequired: false,
      customMetadata: { owner: "ops", status: "decommissioned" },
      createdAt: "2024-11-08T12:00:00Z",
      updatedAt: "2025-02-14T16:21:00Z",
    },
  },
];

// ────────────────────────────────────────────────────────────────────────────────
// Top-level view
// ────────────────────────────────────────────────────────────────────────────────

export function KvView() {
  const [data, setData] = React.useState<KvSecret[]>(INITIAL_DATA);
  const [activePath, setActivePath] = React.useState<string | null>("app/prod/db");
  const [viewingVersion, setViewingVersion] = React.useState<number | null>(null);
  const [query, setQuery] = React.useState("");
  const [tab, setTab] = React.useState<TabKey>("current");

  const active = React.useMemo(
    () => (activePath ? data.find((s) => s.path === activePath) ?? null : null),
    [data, activePath],
  );

  // When the active secret changes, reset to viewing its current version.
  React.useEffect(() => {
    setViewingVersion(null);
    setTab("current");
  }, [activePath]);

  const onSelectPath = (path: string) => {
    setActivePath(path);
  };

  const mutate = (
    path: string,
    fn: (versions: KvVersion[]) => KvVersion[],
  ) =>
    setData((prev) =>
      prev.map((s) =>
        s.path === path
          ? { ...s, versions: fn(s.versions), metadata: { ...s.metadata, updatedAt: new Date().toISOString() } }
          : s,
      ),
    );

  const onSoftDelete = (path: string, version: number) =>
    mutate(path, (vs) =>
      vs.map((v) =>
        v.version === version
          ? { ...v, deletedAt: new Date().toISOString() }
          : v,
      ),
    );

  const onUndelete = (path: string, version: number) =>
    mutate(path, (vs) =>
      vs.map((v) => (v.version === version ? { ...v, deletedAt: undefined } : v)),
    );

  const onDestroy = (path: string, version: number) =>
    mutate(path, (vs) =>
      vs.map((v) =>
        v.version === version
          ? { ...v, destroyed: true, data: Object.fromEntries(Object.keys(v.data).map((k) => [k, "(destroyed)"])) }
          : v,
      ),
    );

  return (
    <div className="space-y-5">
      <Header />
      <div className="grid min-h-[560px] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)] md:grid-cols-[340px_1fr]">
        <PathRail
          data={data}
          activePath={activePath}
          query={query}
          onQueryChange={setQuery}
          onSelectPath={onSelectPath}
        />
        <DetailPane
          secret={active}
          tab={tab}
          onSelectTab={setTab}
          viewingVersion={viewingVersion}
          onSelectVersion={setViewingVersion}
          onSoftDelete={onSoftDelete}
          onUndelete={onUndelete}
          onDestroy={onDestroy}
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Header — eyebrow + title + mount selector + write button (write is a preview no-op)
// ────────────────────────────────────────────────────────────────────────────────

function Header() {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Engine A · infrastructure
        </span>
        <h1 className="font-display text-2xl font-medium tracking-tight">KV secrets</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Versioned key-value paths on the <span className="font-mono text-foreground">{MOUNT}</span>{" "}
          mount. Soft-delete and undelete history, destroy specific versions, and diff a write
          against the version before it.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <MountSelector />
        <IconTip label="Write secret" hint="Coming soon — needs the Engine A write API." side="bottom">
          <span tabIndex={0} className="inline-flex">
            <Button size="sm" variant="secondary" disabled>
              <Plus className="h-3.5 w-3.5" /> Write secret
            </Button>
          </span>
        </IconTip>
      </div>
    </div>
  );
}

function MountSelector() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-2.5 py-1.5 text-sm transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Database className="h-3.5 w-3.5 text-primary" />
          <span className="font-mono text-[12px]">{MOUNT}</span>
          <Badge variant="secondary" className="ml-1 text-[10px] uppercase tracking-wide">
            kv-v2
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel>Mounts</DropdownMenuLabel>
        <DropdownMenuItem className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-primary" />
          <span className="flex-1 font-mono text-[12px]">{MOUNT}</span>
          <Badge variant="secondary">current</Badge>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled className="text-xs text-muted-foreground">
          Additional mounts appear when the Engine A list-mounts API is wired.
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Left rail — search + tree
// ────────────────────────────────────────────────────────────────────────────────

function PathRail({
  data,
  activePath,
  query,
  onQueryChange,
  onSelectPath,
}: {
  data: KvSecret[];
  activePath: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  onSelectPath: (p: string) => void;
}) {
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter((s) => s.path.toLowerCase().includes(q));
  }, [data, query]);

  const tree = React.useMemo(() => buildTree(filtered.map((s) => s.path)), [filtered]);

  return (
    <aside className="flex min-h-0 flex-col border-b border-border bg-[var(--surface-base)] md:border-b-0 md:border-r">
      <div className="flex flex-col gap-2.5 border-b border-border/60 p-3.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={data.length ? `Search ${data.length} paths…` : "Search paths…"}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className="h-9 pl-8 text-sm"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
            Paths
          </span>
          <span className="text-[11px] text-muted-foreground">
            {filtered.length}/{data.length}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            {data.length === 0 ? "No paths in this mount yet." : "No matches."}
          </p>
        ) : (
          <Tree node={tree} depth={0} activePath={activePath} onSelectPath={onSelectPath} data={data} />
        )}
      </div>
    </aside>
  );
}

type TreeNode = { name: string; fullPath: string; children: TreeNode[]; isLeaf: boolean };

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", fullPath: "", children: [], isLeaf: false };
  for (const path of paths) {
    const segs = path.split("/").filter(Boolean);
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!seg) continue;
      const isLast = i === segs.length - 1;
      const full = segs.slice(0, i + 1).join("/");
      let next = cur.children.find((c) => c.name === seg);
      if (!next) {
        next = { name: seg, fullPath: full, children: [], isLeaf: false };
        cur.children.push(next);
      }
      if (isLast) next.isLeaf = true;
      cur = next;
    }
  }
  // Stable sort: folders first, then leaves, alpha within.
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function Tree({
  node,
  depth,
  activePath,
  onSelectPath,
  data,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onSelectPath: (p: string) => void;
  data: KvSecret[];
}) {
  return (
    <ul className="space-y-0.5">
      {node.children.map((child) => (
        <TreeRow
          key={child.fullPath}
          node={child}
          depth={depth}
          activePath={activePath}
          onSelectPath={onSelectPath}
          data={data}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  node,
  depth,
  activePath,
  onSelectPath,
  data,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onSelectPath: (p: string) => void;
  data: KvSecret[];
}) {
  // Open the branch containing the active path by default; user can still toggle.
  const containsActive = activePath?.startsWith(node.fullPath) ?? false;
  const [open, setOpen] = React.useState<boolean>(containsActive);
  React.useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);

  const indent = { paddingLeft: 8 + depth * 12 };
  const isFolder = node.children.length > 0;
  const isActive = node.isLeaf && activePath === node.fullPath;
  const secret = node.isLeaf ? data.find((s) => s.path === node.fullPath) : undefined;
  const status = secret ? secretStatus(secret) : undefined;

  return (
    <li>
      {isFolder ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={indent}
          className="flex w-full items-center gap-1.5 rounded-[var(--radius-md)] py-1 pr-2 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-[var(--surface-hover)] hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="truncate font-mono">{node.name}/</span>
        </button>
      ) : null}

      {node.isLeaf ? (
        <button
          type="button"
          onClick={() => onSelectPath(node.fullPath)}
          style={{ paddingLeft: 8 + depth * 12 + (isFolder ? 0 : 14) }}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-[var(--radius-md)] py-1 pr-2 text-left text-[12px] transition-colors [transition-duration:var(--dur-fast)]",
            isActive
              ? "bg-[var(--ds-accent-subtle)] text-[var(--ds-accent-subtle-fg)]"
              : "text-foreground hover:bg-[var(--surface-hover)]",
          )}
        >
          <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono">{node.name}</span>
          {status && status !== "live" ? (
            <Badge
              variant="secondary"
              className={cn(
                "ml-auto text-[9px] uppercase tracking-wide",
                status === "destroyed"
                  ? "bg-[var(--danger-subtle)] text-[var(--danger-fg)]"
                  : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
              )}
            >
              {status === "destroyed" ? "destroyed" : "deleted"}
            </Badge>
          ) : null}
        </button>
      ) : null}

      {isFolder && open ? (
        <Tree
          node={node}
          depth={depth + 1}
          activePath={activePath}
          onSelectPath={onSelectPath}
          data={data}
        />
      ) : null}
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Right pane — empty state OR hero + tabs
// ────────────────────────────────────────────────────────────────────────────────

function DetailPane({
  secret,
  tab,
  onSelectTab,
  viewingVersion,
  onSelectVersion,
  onSoftDelete,
  onUndelete,
  onDestroy,
}: {
  secret: KvSecret | null;
  tab: TabKey;
  onSelectTab: (t: TabKey) => void;
  viewingVersion: number | null;
  onSelectVersion: (v: number | null) => void;
  onSoftDelete: (path: string, version: number) => void;
  onUndelete: (path: string, version: number) => void;
  onDestroy: (path: string, version: number) => void;
}) {
  if (!secret) {
    return (
      <section className="flex min-h-0 items-center justify-center bg-[var(--surface-sunken)] p-10 text-center">
        <div className="max-w-xs space-y-2">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
            <GitBranch className="h-5 w-5" />
          </span>
          <h3 className="font-display text-base font-semibold">Pick a path</h3>
          <p className="text-sm text-muted-foreground">
            Select a leaf in the tree to see its current version, history, and metadata.
          </p>
        </div>
      </section>
    );
  }

  // Every secret has at least one version by construction (see INITIAL_DATA).
  const currentVersion = secret.versions[0]!;
  const focused =
    viewingVersion !== null
      ? secret.versions.find((v) => v.version === viewingVersion) ?? currentVersion
      : currentVersion;

  return (
    <section className="min-h-0 overflow-y-auto bg-[var(--surface-sunken)]">
      <div className="mx-auto max-w-[640px] px-7 py-7">
        <Hero secret={secret} focused={focused} onResetFocus={() => onSelectVersion(null)} />
        <Tabs tab={tab} onSelectTab={onSelectTab} />
        <div className="mt-5">
          {tab === "current" ? (
            <CurrentTab secret={secret} focused={focused} />
          ) : tab === "versions" ? (
            <VersionsTab
              secret={secret}
              viewingVersion={viewingVersion}
              onSelectVersion={onSelectVersion}
              onSoftDelete={onSoftDelete}
              onUndelete={onUndelete}
              onDestroy={onDestroy}
            />
          ) : (
            <MetadataTab secret={secret} />
          )}
        </div>
        <Footer />
      </div>
    </section>
  );
}

function Hero({
  secret,
  focused,
  onResetFocus,
}: {
  secret: KvSecret;
  focused: KvVersion;
  onResetFocus: () => void;
}) {
  const current = secret.versions[0]!;
  const onOldVersion = focused.version !== current.version;
  return (
    <div className="mb-5 flex items-start gap-4">
      <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-border bg-[var(--surface-raised)] text-primary">
        <FileText className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">{MOUNT}</span>
          <h2 className="truncate font-mono text-[15px] font-semibold tracking-tight">
            {secret.path}
          </h2>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge
            variant="secondary"
            className={cn(
              "text-[10px] uppercase tracking-wide",
              focused.destroyed
                ? "bg-[var(--danger-subtle)] text-[var(--danger-fg)]"
                : focused.deletedAt
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : "",
            )}
          >
            v{focused.version}
            {onOldVersion ? " · viewing" : " · current"}
          </Badge>
          {focused.destroyed ? (
            <Badge variant="secondary" className="bg-[var(--danger-subtle)] text-[var(--danger-fg)]">
              destroyed
            </Badge>
          ) : focused.deletedAt ? (
            <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
              soft-deleted
            </Badge>
          ) : null}
          <span className="text-[11px] text-muted-foreground">
            {focused.createdBy} · {relativeTime(focused.createdAt)}
          </span>
          {onOldVersion ? (
            <button
              type="button"
              onClick={onResetFocus}
              className="ml-1 inline-flex items-center gap-0.5 rounded-full px-1.5 text-[11px] text-primary transition-colors hover:bg-primary/10"
            >
              <X className="h-3 w-3" /> view current
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Tabs({ tab, onSelectTab }: { tab: TabKey; onSelectTab: (t: TabKey) => void }) {
  const items: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: "current", label: "Current", icon: <FileText className="h-3.5 w-3.5" /> },
    { key: "versions", label: "Versions", icon: <History className="h-3.5 w-3.5" /> },
    { key: "metadata", label: "Metadata", icon: <Settings2 className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-border/60">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onSelectTab(it.key)}
          className={cn(
            "inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[12px] font-medium transition-colors",
            tab === it.key
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Current — key-value pairs from the focused version
// ────────────────────────────────────────────────────────────────────────────────

function CurrentTab({ secret, focused }: { secret: KvSecret; focused: KvVersion }) {
  if (focused.destroyed) {
    return (
      <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--danger-fg)]/40 bg-[var(--danger-subtle)] p-5 text-sm">
        <p className="flex items-center gap-2 font-semibold text-[var(--danger-fg)]">
          <ShieldAlert className="h-4 w-4" /> Version {focused.version} was destroyed
        </p>
        <p className="mt-1 text-[var(--danger-fg)]/80">
          Destroy is irreversible. The ciphertext was wiped from the engine — no recovery path
          exists. Pick another version from the History tab.
        </p>
      </div>
    );
  }
  const keys = Object.keys(focused.data);
  if (keys.length === 0) {
    return <p className="text-sm text-muted-foreground">This version has no keys.</p>;
  }
  return (
    <div className="space-y-3">
      {focused.deletedAt ? (
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-muted-foreground">
            This version is <strong>soft-deleted</strong>. Reads return empty from the engine until
            it's undeleted from the Versions tab. The data below is the ciphertext that's still
            recoverable.
          </p>
        </div>
      ) : null}
      {Object.entries(focused.data).map(([k, v]) => (
        <div key={k} className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {k}
          </span>
          <MaskedField value={v} />
        </div>
      ))}
      <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-border/60 bg-[var(--surface-inset)] px-3 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Clock className="h-3 w-3" /> Written {relativeTime(focused.createdAt)} by{" "}
          <span className="font-mono text-foreground">{focused.createdBy}</span>
        </span>
        <span className="font-mono">
          {keys.length} {keys.length === 1 ? "key" : "keys"}
        </span>
      </div>
      <CopyJsonButton data={focused.data} />
    </div>
  );
}

function CopyJsonButton({ data }: { data: Record<string, string> }) {
  const json = React.useMemo(() => JSON.stringify(data, null, 2), [data]);
  return (
    <div className="flex justify-end">
      <CopyButton value={json} label="Copy all as JSON" autoClearSeconds={20} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Versions — list with status, per-row actions, and diff
// ────────────────────────────────────────────────────────────────────────────────

function VersionsTab({
  secret,
  viewingVersion,
  onSelectVersion,
  onSoftDelete,
  onUndelete,
  onDestroy,
}: {
  secret: KvSecret;
  viewingVersion: number | null;
  onSelectVersion: (v: number | null) => void;
  onSoftDelete: (path: string, version: number) => void;
  onUndelete: (path: string, version: number) => void;
  onDestroy: (path: string, version: number) => void;
}) {
  return (
    <ul className="space-y-2">
      {secret.versions.map((v, i) => {
        const prev = secret.versions[i + 1];
        const isFocused = viewingVersion === v.version;
        const status = v.destroyed ? "destroyed" : v.deletedAt ? "deleted" : "live";
        return (
          <li
            key={v.version}
            className={cn(
              "rounded-[var(--radius-md)] border bg-[var(--surface-raised)] p-3 transition-colors",
              isFocused ? "border-primary/50" : "border-border",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-6 min-w-[2.25rem] items-center justify-center rounded-[var(--radius-sm)] border border-border bg-[var(--surface-inset)] px-1.5 font-mono text-[12px] font-semibold">
                v{v.version}
              </span>
              <VersionStatusChip status={status} isCurrent={i === 0 && status === "live"} />
              <span className="text-[12px] text-muted-foreground">
                {relativeTime(v.createdAt)} · <span className="font-mono">{v.createdBy}</span>
              </span>
              <div className="ml-auto flex items-center gap-1">
                {prev && !v.destroyed && !prev.destroyed ? (
                  <DiffDialog from={prev} to={v} path={secret.path} />
                ) : null}
                {!v.destroyed ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onSelectVersion(isFocused ? null : v.version)}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    {isFocused ? "Hide" : "View"}
                  </Button>
                ) : null}
                <VersionActions
                  version={v}
                  onSoftDelete={() => onSoftDelete(secret.path, v.version)}
                  onUndelete={() => onUndelete(secret.path, v.version)}
                  onDestroy={() => onDestroy(secret.path, v.version)}
                />
              </div>
            </div>
            {isFocused && !v.destroyed ? (
              <div className="mt-3 grid gap-2 rounded-[var(--radius-md)] border border-border/60 bg-[var(--surface-inset)] p-3">
                {Object.entries(v.data).map(([k, val]) => (
                  <div key={k} className="flex flex-col gap-1">
                    <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {k}
                    </span>
                    <MaskedField value={val} />
                  </div>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function VersionStatusChip({
  status,
  isCurrent,
}: {
  status: "live" | "deleted" | "destroyed";
  isCurrent: boolean;
}) {
  if (status === "destroyed") {
    return (
      <Badge variant="secondary" className="bg-[var(--danger-subtle)] text-[var(--danger-fg)]">
        destroyed
      </Badge>
    );
  }
  if (status === "deleted") {
    return (
      <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
        soft-deleted
      </Badge>
    );
  }
  if (isCurrent) {
    return (
      <Badge variant="secondary" className="bg-primary/12 text-primary">
        current
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-muted-foreground">
      historic
    </Badge>
  );
}

function VersionActions({
  version,
  onSoftDelete,
  onUndelete,
  onDestroy,
}: {
  version: KvVersion;
  onSoftDelete: () => void;
  onUndelete: () => void;
  onDestroy: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Version actions">
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        {version.destroyed ? (
          <DropdownMenuItem disabled>
            <ShieldAlert className="h-3.5 w-3.5" /> Destroyed — no recovery
          </DropdownMenuItem>
        ) : version.deletedAt ? (
          <DropdownMenuItem onSelect={onUndelete}>
            <RotateCcw className="h-3.5 w-3.5" /> Undelete
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onSoftDelete}>
            <FileClock className="h-3.5 w-3.5" /> Soft-delete
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onDestroy}
          disabled={version.destroyed}
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" /> Destroy permanently
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DiffDialog({ from, to, path }: { from: KvVersion; to: KvVersion; path: string }) {
  const rows = React.useMemo(() => diffVersions(from, to), [from, to]);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <ArrowLeftRight className="h-3.5 w-3.5" /> Diff
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {path} · v{from.version} → v{to.version}
          </DialogTitle>
          <DialogDescription>
            Lines added, removed, or changed between the two versions. Values are masked until you
            reveal them.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[420px] overflow-y-auto rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)]">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No differences.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {rows.map((row) => (
                <DiffRow key={row.key} row={row} />
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DiffRowShape =
  | { kind: "added"; key: string; to: string }
  | { kind: "removed"; key: string; from: string }
  | { kind: "changed"; key: string; from: string; to: string };

function diffVersions(from: KvVersion, to: KvVersion): DiffRowShape[] {
  const rows: DiffRowShape[] = [];
  const keys = new Set<string>([...Object.keys(from.data), ...Object.keys(to.data)]);
  for (const key of Array.from(keys).sort()) {
    const f = from.data[key];
    const t = to.data[key];
    if (f === undefined && t !== undefined) rows.push({ kind: "added", key, to: t });
    else if (f !== undefined && t === undefined) rows.push({ kind: "removed", key, from: f });
    else if (f !== t) rows.push({ kind: "changed", key, from: f as string, to: t as string });
  }
  return rows;
}

function DiffRow({ row }: { row: DiffRowShape }) {
  const tone =
    row.kind === "added"
      ? "bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
      : row.kind === "removed"
        ? "bg-[var(--danger-subtle)] text-[var(--danger-fg)]"
        : "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return (
    <li className="p-2.5">
      <div className="flex items-center gap-2">
        <Badge
          variant="secondary"
          className={cn("text-[10px] uppercase tracking-wide", tone)}
        >
          {row.kind}
        </Badge>
        <span className="font-mono text-[12px] font-medium">{row.key}</span>
      </div>
      <div className="mt-2 grid gap-1.5">
        {row.kind === "changed" ? (
          <>
            <DiffSide label="before" value={row.from} tone="removed" />
            <DiffSide label="after" value={row.to} tone="added" />
          </>
        ) : row.kind === "added" ? (
          <DiffSide label="value" value={row.to} tone="added" />
        ) : (
          <DiffSide label="value" value={row.from} tone="removed" />
        )}
      </div>
    </li>
  );
}

function DiffSide({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "added" | "removed";
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[12px]",
        tone === "added"
          ? "border-emerald-500/20 bg-emerald-500/5"
          : "border-[var(--danger-fg)]/20 bg-[var(--danger-subtle)]/40",
      )}
    >
      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="ml-auto flex-1 truncate text-right">
        <MaskedField value={value} dots={8} />
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Metadata
// ────────────────────────────────────────────────────────────────────────────────

function MetadataTab({ secret }: { secret: KvSecret }) {
  const m = secret.metadata;
  const entries = Object.entries(m.customMetadata);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <MetaCell label="Max versions" value={String(m.maxVersions)} />
        <MetaCell label="CAS required" value={m.casRequired ? "yes" : "no"} />
        <MetaCell label="Created" value={formatTime(m.createdAt)} />
        <MetaCell label="Updated" value={formatTime(m.updatedAt)} />
        <MetaCell label="Versions retained" value={String(secret.versions.length)} />
        <MetaCell
          label="Live versions"
          value={String(secret.versions.filter((v) => !v.deletedAt && !v.destroyed).length)}
        />
      </div>
      <div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Custom metadata
        </span>
        {entries.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">No custom metadata set.</p>
        ) : (
          <ul className="mt-1.5 divide-y divide-border/60 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)]">
            {entries.map(([k, v]) => (
              <li key={k} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {k}
                </span>
                <span className="ml-auto font-mono">{v}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-[13px]">{value}</p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Footer — honest trust signal: engine-side encryption, preview surface
// ────────────────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <div className="mt-6 flex items-center gap-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
      <TrustIndicator kind="verified">Engine A · KV v2</TrustIndicator>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
        <Sparkles className="h-3 w-3" /> preview · writes wire next
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

function secretStatus(secret: KvSecret): "live" | "deleted" | "destroyed" {
  const current = secret.versions[0]!;
  if (current.destroyed) return "destroyed";
  if (current.deletedAt) return "deleted";
  return "live";
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
