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
import { Label } from "@/components/ui/label";
import { IconTip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/arc/copy-button";
import { MaskedField } from "@/components/arc/masked-field";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { VaultClient } from "@arc/sdk";

/**
 * Operator KV (v2) browser — implements the arc-console design-kit operator screen
 * (Engine A · Infrastructure → "KV secrets"). Left rail is a search + path tree; right
 * pane has the path hero plus three tabs: Current, Versions, Metadata. Versions carry
 * soft-delete / undelete / destroy actions and a diff against the previous version.
 *
 * Wired to the real engine surface via the SDK's `kv*` helpers, which call the Vault-
 * compatible `/v1/<mount>/...` routes the arc-server engines controller exposes. The
 * server has done the OpenBao plumbing already (`OpenBaoKvEngine` + `EnginesService`);
 * this view only talks to the SDK.
 *
 * Degrade-gracefully posture: when no KV mount is configured (the dev default when
 * `BAO_ADDR` is unset), the view shows an honest "no KV mount" empty state with the
 * one-line how-to instead of faking data.
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
// Engine-state machine
//
// `loading`     → first list-mounts in flight.
// `no-mount`    → server returned 0 KV mounts (Engine A not configured / no mounts).
// `error`       → the list call failed; show the error + a retry.
// `ready`       → we know our mount; path tree is loaded.
// ────────────────────────────────────────────────────────────────────────────────

type EngineState = "loading" | "no-mount" | "error" | "ready";

/**
 * Placeholder `createdBy` for SDK-backed versions. OpenBao's metadata response doesn't
 * carry the writer's identity; we'd need to record it ourselves in `custom_metadata` at
 * write time to surface a real name. Showing "—" keeps the UI honest until then.
 */
const UNKNOWN_AUTHOR = "—";


// ────────────────────────────────────────────────────────────────────────────────
// Top-level view
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Live KV browser. State machine:
 *
 *   1. **boot**: list mounts → pick the first `kv-v2` mount → list its paths recursively
 *      to populate the tree. Empty mount list → `no-mount` empty state.
 *   2. **path-select**: load that path's full metadata + every version's data in parallel
 *      so the Current/Versions tabs render with no further fetches. Cached in `data`.
 *   3. **mutate** (soft-delete / undelete / destroy / write): call the SDK, then
 *      re-fetch the path's metadata + data to reflect the engine's truth (e.g. a write
 *      may have evicted the oldest version under `max_versions`).
 *
 * All fetch surface goes through {@link VaultClient}; nothing here speaks fetch directly.
 */
export function KvView({ getClient }: { getClient: () => VaultClient }) {
  const [engineState, setEngineState] = React.useState<EngineState>("loading");
  const [engineError, setEngineError] = React.useState<string | null>(null);
  const [mounts, setMounts] = React.useState<Array<{ path: string; type: string }>>([]);
  const [mount, setMount] = React.useState<string>("");
  const [data, setData] = React.useState<KvSecret[]>([]);
  const [activePath, setActivePath] = React.useState<string | null>(null);
  const [viewingVersion, setViewingVersion] = React.useState<number | null>(null);
  const [query, setQuery] = React.useState("");
  const [tab, setTab] = React.useState<TabKey>("current");
  const [pathBusy, setPathBusy] = React.useState<string | null>(null);

  const active = React.useMemo(
    () => (activePath ? data.find((s) => s.path === activePath) ?? null : null),
    [data, activePath],
  );

  /** Load mount list + path tree for the chosen mount. Run on boot + on retry/mount change. */
  const loadMount = React.useCallback(
    async (preferredMount?: string) => {
      setEngineState("loading");
      setEngineError(null);
      try {
        const ms = await getClient().listMounts();
        setMounts(ms);
        const kvMounts = ms.filter((m) => m.type === "kv-v2");
        if (kvMounts.length === 0) {
          setEngineState("no-mount");
          return;
        }
        const chosen = preferredMount && kvMounts.find((m) => m.path === preferredMount)
          ? preferredMount
          : kvMounts[0]!.path;
        setMount(chosen);
        const paths = await listAllPaths(getClient(), chosen, "");
        setData(paths.sort().map((p) => ({ path: p, versions: [], metadata: emptyMeta() })));
        setActivePath(paths[0] ?? null);
        setEngineState("ready");
      } catch (err) {
        setEngineError((err as Error).message);
        setEngineState("error");
      }
    },
    [getClient],
  );

  React.useEffect(() => {
    void loadMount();
  }, [loadMount]);

  /** Eagerly fetch a path's metadata + all version data; cache into `data`. */
  const refreshPath = React.useCallback(
    async (path: string) => {
      setPathBusy(path);
      try {
        const meta = await getClient().kvMetadata(mount, path);
        const versions = await Promise.all(
          meta.versions.map(async (v): Promise<KvVersion> => {
            if (v.destroyed) {
              return {
                version: v.version,
                data: {},
                createdAt: v.createdTime,
                createdBy: UNKNOWN_AUTHOR,
                destroyed: true,
                ...(v.deletionTime ? { deletedAt: v.deletionTime } : {}),
              };
            }
            if (v.deletionTime) {
              return {
                version: v.version,
                data: {},
                createdAt: v.createdTime,
                createdBy: UNKNOWN_AUTHOR,
                deletedAt: v.deletionTime,
              };
            }
            try {
              const r = await getClient().kvRead(mount, path, { version: v.version });
              return {
                version: v.version,
                data: toStringMap(r.data),
                createdAt: r.metadata.createdTime || v.createdTime,
                createdBy: UNKNOWN_AUTHOR,
              };
            } catch {
              // Version disappeared between metadata and read — treat as soft-deleted.
              return {
                version: v.version,
                data: {},
                createdAt: v.createdTime,
                createdBy: UNKNOWN_AUTHOR,
                deletedAt: new Date().toISOString(),
              };
            }
          }),
        );
        setData((prev) =>
          prev.map((s) =>
            s.path === path
              ? {
                  ...s,
                  versions,
                  metadata: {
                    maxVersions: meta.maxVersions,
                    casRequired: meta.casRequired,
                    customMetadata: meta.customMetadata,
                    createdAt: meta.createdTime,
                    updatedAt: meta.updatedTime,
                  },
                }
              : s,
          ),
        );
      } finally {
        setPathBusy((p) => (p === path ? null : p));
      }
    },
    [getClient, mount],
  );

  // When the active path changes, reset focus + load its details on demand (only if not
  // already cached — switching back to a path you've visited is instant).
  React.useEffect(() => {
    setViewingVersion(null);
    setTab("current");
    if (!activePath) return;
    const sec = data.find((s) => s.path === activePath);
    if (!sec || sec.versions.length === 0) void refreshPath(activePath);
    // `data` is intentionally not in the dep array: refreshPath updates `data` itself, and
    // including it would re-fire the effect on every load and loop. The "cached?" probe is
    // a one-shot decision per `activePath` change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, refreshPath]);

  const handleOp = async (path: string, op: () => Promise<unknown>, success: string) => {
    try {
      await op();
      await refreshPath(path);
      toast.success(success);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const onSoftDelete = (path: string, version: number) =>
    handleOp(path, () => getClient().kvDeleteVersions(mount, path, [version]), `Version ${version} soft-deleted`);

  const onUndelete = (path: string, version: number) =>
    handleOp(path, () => getClient().kvUndeleteVersions(mount, path, [version]), `Version ${version} restored`);

  const onDestroy = (path: string, version: number) =>
    handleOp(path, () => getClient().kvDestroyVersions(mount, path, [version]), `Version ${version} destroyed`);

  const onWrite = async (path: string, payload: Record<string, string>) => {
    try {
      await getClient().kvWrite(mount, path, payload);
      // A new path doesn't appear in the tree until we know about it — refresh the list.
      const known = data.find((s) => s.path === path);
      if (!known) {
        const paths = await listAllPaths(getClient(), mount, "");
        setData((prev) => {
          const byPath = new Map(prev.map((s) => [s.path, s]));
          return paths.sort().map((p) => byPath.get(p) ?? { path: p, versions: [], metadata: emptyMeta() });
        });
      }
      setActivePath(path);
      await refreshPath(path);
      toast.success(`Wrote ${path}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (engineState === "loading") {
    return (
      <div className="space-y-5">
        <Header mount={mount || "—"} mounts={mounts} onSelectMount={loadMount} writable={false} onWrite={onWrite} />
        <div className="grid min-h-[480px] place-items-center rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)] text-sm text-muted-foreground">
          Loading KV mounts…
        </div>
      </div>
    );
  }
  if (engineState === "no-mount") {
    return (
      <div className="space-y-5">
        <Header mount="—" mounts={mounts} onSelectMount={loadMount} writable={false} onWrite={onWrite} />
        <EmptyEngineState
          title="No KV mount configured"
          body="Engine A is reachable but no KV v2 mount is registered on this arc-server. Start a colocated OpenBao (or set BAO_ADDR to point at one) and arc will auto-mount `secret/` on boot."
          retry={() => loadMount()}
        />
      </div>
    );
  }
  if (engineState === "error") {
    return (
      <div className="space-y-5">
        <Header mount="—" mounts={mounts} onSelectMount={loadMount} writable={false} onWrite={onWrite} />
        <EmptyEngineState
          title="Couldn’t load the KV engine"
          body={engineError ?? "The list-mounts call failed. The most common cause is the engine being temporarily unreachable."}
          retry={() => loadMount()}
        />
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <Header mount={mount} mounts={mounts} onSelectMount={loadMount} writable onWrite={onWrite} />
      <div className="grid min-h-[560px] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)] md:grid-cols-[340px_1fr]">
        <PathRail
          data={data}
          activePath={activePath}
          query={query}
          onQueryChange={setQuery}
          onSelectPath={setActivePath}
        />
        <DetailPane
          mount={mount}
          secret={active}
          loading={pathBusy === activePath && (active?.versions.length ?? 0) === 0}
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

function emptyMeta(): KvSecret["metadata"] {
  return { maxVersions: 0, casRequired: false, customMetadata: {}, createdAt: "", updatedAt: "" };
}

function toStringMap(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * Recursively walk a KV mount via `kvList` to flatten every leaf path into a flat array
 * the existing tree component can group by `/`. Folder entries from `kvList` end in `/`;
 * we recurse into them. Errors per-subtree are swallowed (a sub-prefix may have been
 * deleted between calls) so a partial tree still renders.
 */
async function listAllPaths(client: VaultClient, mount: string, prefix: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await client.kvList(mount, prefix);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.endsWith("/")) {
      out.push(...(await listAllPaths(client, mount, prefix + e)));
    } else {
      out.push(prefix + e);
    }
  }
  return out;
}

function EmptyEngineState({ title, body, retry }: { title: string; body: string; retry: () => void }) {
  return (
    <div className="flex min-h-[480px] flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-border bg-[var(--surface-base)] p-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
        <Database className="h-5 w-5" />
      </span>
      <h3 className="font-display text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        <RotateCcw className="h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Header — eyebrow + title + mount selector + write button
// ────────────────────────────────────────────────────────────────────────────────

function Header({
  mount,
  mounts,
  onSelectMount,
  writable,
  onWrite,
}: {
  mount: string;
  mounts: Array<{ path: string; type: string }>;
  onSelectMount: (path: string) => void;
  writable: boolean;
  onWrite: (path: string, data: Record<string, string>) => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Engine A · infrastructure
        </span>
        <h1 className="font-display text-2xl font-medium tracking-tight">KV secrets</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Versioned key-value paths on the <span className="font-mono text-foreground">{mount}</span>{" "}
          mount. Soft-delete and undelete history, destroy specific versions, and diff a write
          against the version before it.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <MountSelector mount={mount} mounts={mounts} onSelect={onSelectMount} />
        {writable ? (
          <WriteSecretDialog onWrite={onWrite} />
        ) : (
          <IconTip label="Write secret" hint="Pick a KV mount first." side="bottom">
            <span tabIndex={0} className="inline-flex">
              <Button size="sm" variant="secondary" disabled>
                <Plus className="h-3.5 w-3.5" /> Write secret
              </Button>
            </span>
          </IconTip>
        )}
      </div>
    </div>
  );
}

function MountSelector({
  mount,
  mounts,
  onSelect,
}: {
  mount: string;
  mounts: Array<{ path: string; type: string }>;
  onSelect: (path: string) => void;
}) {
  const kvMounts = mounts.filter((m) => m.type === "kv-v2");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-2.5 py-1.5 text-sm transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Database className="h-3.5 w-3.5 text-primary" />
          <span className="font-mono text-[12px]">{mount}</span>
          <Badge variant="secondary" className="ml-1 text-[10px] uppercase tracking-wide">
            kv-v2
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel>KV mounts</DropdownMenuLabel>
        {kvMounts.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            No KV mounts.
          </DropdownMenuItem>
        ) : (
          kvMounts.map((m) => (
            <DropdownMenuItem
              key={m.path}
              onSelect={() => onSelect(m.path)}
              className="flex items-center gap-2"
            >
              <Database className="h-3.5 w-3.5 text-primary" />
              <span className="flex-1 font-mono text-[12px]">{m.path}</span>
              {m.path === mount ? <Badge variant="secondary">current</Badge> : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Write a new version (or create a new path). Keeps the same Dialog primitive every other
 * dialog uses, so it inherits the platform's blurred scrim + radius tokens. Each field row
 * is a key/value pair; user can add or remove rows before saving.
 */
function WriteSecretDialog({
  onWrite,
}: {
  onWrite: (path: string, data: Record<string, string>) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [path, setPath] = React.useState("");
  const [rows, setRows] = React.useState<Array<{ k: string; v: string }>>([{ k: "", v: "" }]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setPath("");
      setRows([{ k: "", v: "" }]);
    }
  }, [open]);

  const submit = async () => {
    const data: Record<string, string> = {};
    for (const r of rows) {
      const k = r.k.trim();
      if (!k) continue;
      data[k] = r.v;
    }
    const cleanPath = path.replace(/^\/+|\/+$/g, "");
    if (!cleanPath || Object.keys(data).length === 0) return;
    setBusy(true);
    try {
      await onWrite(cleanPath, data);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" /> Write secret
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Write a KV secret</DialogTitle>
          <DialogDescription>
            Creates a new path or bumps an existing one to the next version. The engine keeps
            previous versions per its <span className="font-mono">max_versions</span> setting.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="kv-path">Path</Label>
            <Input
              id="kv-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="app/prod/db"
              className="font-mono"
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Key/value pairs</Label>
            <div className="space-y-1.5">
              {rows.map((row, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input
                    aria-label={`Key ${i + 1}`}
                    placeholder="KEY"
                    className="font-mono"
                    value={row.k}
                    onChange={(e) =>
                      setRows((rs) => rs.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))
                    }
                  />
                  <Input
                    aria-label={`Value ${i + 1}`}
                    placeholder="value"
                    className="font-mono"
                    value={row.v}
                    onChange={(e) =>
                      setRows((rs) => rs.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove row ${i + 1}`}
                    disabled={rows.length === 1}
                    onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRows((rs) => [...rs, { k: "", v: "" }])}
              >
                <Plus className="h-3 w-3" /> Add row
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={busy || !path.trim() || rows.every((r) => !r.k.trim())}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  mount,
  secret,
  loading,
  tab,
  onSelectTab,
  viewingVersion,
  onSelectVersion,
  onSoftDelete,
  onUndelete,
  onDestroy,
}: {
  mount: string;
  secret: KvSecret | null;
  loading: boolean;
  tab: TabKey;
  onSelectTab: (t: TabKey) => void;
  viewingVersion: number | null;
  onSelectVersion: (v: number | null) => void;
  onSoftDelete: (path: string, version: number) => void;
  onUndelete: (path: string, version: number) => void;
  onDestroy: (path: string, version: number) => void;
}) {
  // Path is selected but its versions haven't arrived yet — render a loading placeholder
  // rather than the `versions[0]!` access (the existing tabs invariant).
  if (secret && loading) {
    return (
      <section className="grid min-h-0 place-items-center bg-[var(--surface-sunken)] p-10 text-sm text-muted-foreground">
        Loading {secret.path}…
      </section>
    );
  }
  // A selected path with zero versions after the load completes: every version was
  // destroyed (the metadata survives but no data). Surface that explicitly instead of
  // throwing on `versions[0]!`.
  if (secret && secret.versions.length === 0) {
    return (
      <section className="grid min-h-0 place-items-center bg-[var(--surface-sunken)] p-10 text-center text-sm text-muted-foreground">
        <div className="max-w-sm space-y-2">
          <p className="font-medium">No versions</p>
          <p>This path has no live or recoverable versions on the engine.</p>
        </div>
      </section>
    );
  }
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
        <Hero mount={mount} secret={secret} focused={focused} onResetFocus={() => onSelectVersion(null)} />
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
  mount,
  secret,
  focused,
  onResetFocus,
}: {
  mount: string;
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
          <span className="font-mono text-[11px] text-muted-foreground">{mount}</span>
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
        <Sparkles className="h-3 w-3" /> live · OpenBao via arc-server
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
