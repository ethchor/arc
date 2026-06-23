"use client";

import * as React from "react";
import {
  ChevronDown,
  Database,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Unlock,
} from "lucide-react";
import { toast } from "sonner";
import type { TransitKeyInfoWire, VaultClient } from "@arc/sdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IconTip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/arc/copy-button";
import { TrustIndicator } from "@/components/arc/trust-indicator";
import { cn } from "@/lib/utils";
import { relativeAgo } from "@/lib/datetime";

/**
 * Operator Transit (encryption-as-a-service) browser. Mirrors the arc-console operator
 * screen: mount selector + key list rail + detail pane with a key-info section and an
 * encrypt/decrypt playground. Everything goes through `transit*` on {@link VaultClient};
 * no key material crosses this surface — only opaque `vault:v<N>:<b64>` ciphertexts.
 *
 * Honest "no mount" empty state when no `transit` mount is registered (the dev default
 * when `BAO_ADDR` is unset) — no faked data.
 */

type EngineState = "loading" | "no-mount" | "error" | "ready";

/** Algorithm choices surfaced in the create-key dialog. OpenBao supports many more; we
 *  expose the ones an operator actually picks day-to-day so the create flow stays simple. */
const ALGORITHMS = [
  { value: "aes256-gcm96", label: "AES-256-GCM-96", hint: "Default symmetric; AEAD." },
  { value: "chacha20-poly1305", label: "ChaCha20-Poly1305", hint: "AEAD; faster on no-AES-NI CPUs." },
  { value: "aes128-gcm96", label: "AES-128-GCM-96", hint: "Symmetric, smaller key." },
];

export function TransitView({ getClient }: { getClient: () => VaultClient }) {
  const [engineState, setEngineState] = React.useState<EngineState>("loading");
  const [engineError, setEngineError] = React.useState<string | null>(null);
  const [mounts, setMounts] = React.useState<Array<{ path: string; type: string }>>([]);
  const [mount, setMount] = React.useState<string>("");
  const [keys, setKeys] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [keyInfo, setKeyInfo] = React.useState<TransitKeyInfoWire | null>(null);
  const [keyBusy, setKeyBusy] = React.useState<string | null>(null);

  const loadMount = React.useCallback(
    async (preferredMount?: string) => {
      setEngineState("loading");
      setEngineError(null);
      try {
        const ms = await getClient().listMounts();
        setMounts(ms);
        const transitMounts = ms.filter((m) => m.type === "transit");
        if (transitMounts.length === 0) {
          setEngineState("no-mount");
          return;
        }
        const chosen =
          preferredMount && transitMounts.find((m) => m.path === preferredMount)
            ? preferredMount
            : transitMounts[0]!.path;
        setMount(chosen);
        const names = await getClient().transitListKeys(chosen);
        const sorted = [...names].sort();
        setKeys(sorted);
        setActiveKey(sorted[0] ?? null);
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

  const refreshKey = React.useCallback(
    async (name: string) => {
      setKeyBusy(name);
      try {
        const info = await getClient().transitReadKey(mount, name);
        setKeyInfo(info);
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setKeyBusy((k) => (k === name ? null : k));
      }
    },
    [getClient, mount],
  );

  // Load (or re-load) the active key's info whenever the selection changes.
  React.useEffect(() => {
    if (!activeKey) {
      setKeyInfo(null);
      return;
    }
    setKeyInfo(null);
    void refreshKey(activeKey);
  }, [activeKey, refreshKey]);

  const onCreate = async (name: string, algorithm: string, exportable: boolean) => {
    try {
      await getClient().transitCreateKey(mount, name, { algorithm, exportable });
      const names = await getClient().transitListKeys(mount);
      setKeys([...names].sort());
      setActiveKey(name);
      toast.success(`Created ${name}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const onRotate = async (name: string) => {
    try {
      const { latestVersion } = await getClient().transitRotateKey(mount, name);
      toast.success(`Rotated ${name} → v${latestVersion}`);
      await refreshKey(name);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (engineState === "loading") {
    return (
      <ChromeShell mount={mount || "—"} mounts={mounts} onSelectMount={loadMount} onCreate={onCreate} createDisabled>
        <div className="grid min-h-[480px] place-items-center rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)] text-sm text-muted-foreground">
          Loading transit mounts…
        </div>
      </ChromeShell>
    );
  }
  if (engineState === "no-mount") {
    return (
      <ChromeShell mount="—" mounts={mounts} onSelectMount={loadMount} onCreate={onCreate} createDisabled>
        <EmptyEngineState
          title="No transit mount configured"
          body="Engine A is reachable but no transit mount is registered on this arc-server. Start a colocated OpenBao (or set BAO_ADDR to point at one) and arc will auto-mount `transit/` on boot."
          retry={() => loadMount()}
        />
      </ChromeShell>
    );
  }
  if (engineState === "error") {
    return (
      <ChromeShell mount="—" mounts={mounts} onSelectMount={loadMount} onCreate={onCreate} createDisabled>
        <EmptyEngineState
          title="Couldn’t load the transit engine"
          body={engineError ?? "The list-mounts call failed. Most often this is the engine being temporarily unreachable."}
          retry={() => loadMount()}
        />
      </ChromeShell>
    );
  }

  return (
    <ChromeShell mount={mount} mounts={mounts} onSelectMount={loadMount} onCreate={onCreate}>
      <div className="grid min-h-[560px] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--surface-base)] md:grid-cols-[300px_1fr]">
        <KeyRail
          keys={keys}
          activeKey={activeKey}
          query={query}
          onQueryChange={setQuery}
          onSelectKey={setActiveKey}
        />
        <DetailPane
          mount={mount}
          getClient={getClient}
          name={activeKey}
          info={keyInfo}
          loading={keyBusy === activeKey && keyInfo === null}
          onRotate={() => activeKey && onRotate(activeKey)}
          onRefresh={() => activeKey && void refreshKey(activeKey)}
        />
      </div>
    </ChromeShell>
  );
}

function ChromeShell({
  mount,
  mounts,
  onSelectMount,
  onCreate,
  createDisabled,
  children,
}: {
  mount: string;
  mounts: Array<{ path: string; type: string }>;
  onSelectMount: (path: string) => void;
  onCreate: (name: string, algorithm: string, exportable: boolean) => Promise<void>;
  createDisabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Engine A · infrastructure
          </span>
          <h1 className="font-display text-2xl font-medium tracking-tight">Transit</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Encryption-as-a-service backed by OpenBao. Key material never leaves the engine —
            this surface only mints opaque <span className="font-mono text-foreground">vault:v&lt;N&gt;:…</span>{" "}
            ciphertexts. Rotate to bump the version; older ciphertext stays decryptable.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MountSelector mount={mount} mounts={mounts} onSelect={onSelectMount} />
          {createDisabled ? (
            <IconTip label="New key" hint="Pick a transit mount first." side="bottom">
              <span tabIndex={0} className="inline-flex">
                <Button size="sm" variant="secondary" disabled>
                  <Plus className="h-3.5 w-3.5" /> New key
                </Button>
              </span>
            </IconTip>
          ) : (
            <CreateKeyDialog onCreate={onCreate} />
          )}
        </div>
      </div>
      {children}
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
  const transitMounts = mounts.filter((m) => m.type === "transit");
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
            transit
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuLabel>Transit mounts</DropdownMenuLabel>
        {transitMounts.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            No transit mounts.
          </DropdownMenuItem>
        ) : (
          transitMounts.map((m) => (
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

function EmptyEngineState({ title, body, retry }: { title: string; body: string; retry: () => void }) {
  return (
    <div className="flex min-h-[480px] flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-border bg-[var(--surface-base)] p-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
        <KeyRound className="h-5 w-5" />
      </span>
      <h3 className="font-display text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        <RotateCcw className="h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}

function KeyRail({
  keys,
  activeKey,
  query,
  onQueryChange,
  onSelectKey,
}: {
  keys: string[];
  activeKey: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  onSelectKey: (k: string) => void;
}) {
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? keys.filter((k) => k.toLowerCase().includes(q)) : keys;
  }, [keys, query]);
  return (
    <aside className="flex min-h-0 flex-col border-b border-border bg-[var(--surface-base)] md:border-b-0 md:border-r">
      <div className="flex flex-col gap-2.5 border-b border-border/60 p-3.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={keys.length ? `Search ${keys.length} keys…` : "Search keys…"}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className="h-9 pl-8 text-sm"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
            Keys
          </span>
          <span className="text-[11px] text-muted-foreground">
            {filtered.length}/{keys.length}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            {keys.length === 0 ? "No transit keys yet — create one above." : "No matches."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => onSelectKey(k)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-[12px] transition-colors [transition-duration:var(--dur-fast)]",
                    activeKey === k
                      ? "bg-[var(--ds-accent-subtle)] text-[var(--ds-accent-subtle-fg)]"
                      : "text-foreground hover:bg-[var(--surface-hover)]",
                  )}
                >
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono">{k}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function DetailPane({
  mount,
  getClient,
  name,
  info,
  loading,
  onRotate,
  onRefresh,
}: {
  mount: string;
  getClient: () => VaultClient;
  name: string | null;
  info: TransitKeyInfoWire | null;
  loading: boolean;
  onRotate: () => void;
  onRefresh: () => void;
}) {
  if (!name) {
    return (
      <section className="grid min-h-0 place-items-center bg-[var(--surface-sunken)] p-10 text-center">
        <div className="max-w-xs space-y-2">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
            <KeyRound className="h-5 w-5" />
          </span>
          <h3 className="font-display text-base font-semibold">Pick a key</h3>
          <p className="text-sm text-muted-foreground">
            Select a key on the left to read its posture and try encrypt/decrypt.
          </p>
        </div>
      </section>
    );
  }
  if (loading || !info) {
    return (
      <section className="grid min-h-0 place-items-center bg-[var(--surface-sunken)] p-10 text-sm text-muted-foreground">
        Loading {name}…
      </section>
    );
  }
  return (
    <section className="min-h-0 overflow-y-auto bg-[var(--surface-sunken)]">
      <div className="mx-auto max-w-[640px] px-7 py-7 space-y-5">
        <Hero mount={mount} info={info} onRotate={onRotate} onRefresh={onRefresh} />
        <KeyInfoCard info={info} />
        <Playground mount={mount} keyName={info.name} getClient={getClient} />
        <Footer />
      </div>
    </section>
  );
}

function Hero({
  mount,
  info,
  onRotate,
  onRefresh,
}: {
  mount: string;
  info: TransitKeyInfoWire;
  onRotate: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-border bg-[var(--surface-raised)] text-primary">
        <KeyRound className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">{mount}</span>
          <h2 className="truncate font-mono text-[15px] font-semibold tracking-tight">
            {info.name}
          </h2>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="bg-primary/12 text-primary">
            v{info.latestVersion} · current
          </Badge>
          <Badge variant="secondary" className="text-muted-foreground">
            {info.type || "—"}
          </Badge>
          {info.exportable ? (
            <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
              exportable
            </Badge>
          ) : null}
          {info.deletionAllowed ? (
            <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
              deletion allowed
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <IconTip label="Refresh" hint="Re-read this key's posture from the engine." side="bottom">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRefresh} aria-label="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </IconTip>
        <IconTip label="Rotate" hint="Advance the key to a new version. Older versions stay valid for decrypt." side="bottom">
          <Button size="sm" variant="secondary" onClick={onRotate}>
            <RotateCcw className="h-3.5 w-3.5" /> Rotate
          </Button>
        </IconTip>
      </div>
    </div>
  );
}

function KeyInfoCard({ info }: { info: TransitKeyInfoWire }) {
  const versions = info.versionCreatedAt ?? {};
  const entries = Object.entries(versions).sort((a, b) => Number(b[0]) - Number(a[0]));
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Cell label="Latest version" value={String(info.latestVersion)} />
        <Cell label="Algorithm" value={info.type || "—"} />
        <Cell label="Min decryption version" value={String(info.minDecryptionVersion)} />
        <Cell label="Min encryption version" value={String(info.minEncryptionVersion)} />
        <Cell label="Deletion allowed" value={info.deletionAllowed ? "yes" : "no"} />
        <Cell label="Exportable" value={info.exportable ? "yes" : "no"} />
      </div>
      {entries.length > 0 ? (
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Versions
          </span>
          <ul className="mt-1.5 divide-y divide-border/60 rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)]">
            {entries.map(([v, ts]) => (
              <li key={v} className="flex items-center gap-3 px-3 py-2 text-[12px]">
                <span className="inline-flex h-5 min-w-[2rem] items-center justify-center rounded-[var(--radius-sm)] border border-border bg-[var(--surface-raised)] px-1.5 font-mono font-semibold">
                  v{v}
                </span>
                <span className="ml-auto font-mono text-muted-foreground">
                  {relativeAgo(ts)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-[13px]">{value}</p>
    </div>
  );
}

/**
 * Inline encrypt/decrypt try-it. Plaintext encoded as UTF-8 → bytes → base64 client-side,
 * then sent to the SDK which base64-decodes back to bytes before posting to the engine.
 * Decrypt accepts a `vault:v<N>:…` ciphertext and renders the plaintext as UTF-8.
 */
function Playground({
  mount,
  keyName,
  getClient,
}: {
  mount: string;
  keyName: string;
  getClient: () => VaultClient;
}) {
  const [plaintext, setPlaintext] = React.useState("");
  const [ciphertext, setCiphertext] = React.useState("");
  const [decryptIn, setDecryptIn] = React.useState("");
  const [decryptOut, setDecryptOut] = React.useState("");
  const [encBusy, setEncBusy] = React.useState(false);
  const [decBusy, setDecBusy] = React.useState(false);

  // Reset on key change — pasted ciphertext from one key would refuse to decrypt under another.
  React.useEffect(() => {
    setPlaintext("");
    setCiphertext("");
    setDecryptIn("");
    setDecryptOut("");
  }, [keyName, mount]);

  const onEncrypt = async () => {
    setEncBusy(true);
    try {
      const bytes = new TextEncoder().encode(plaintext);
      const r = await getClient().transitEncrypt(mount, keyName, bytes);
      setCiphertext(r.ciphertext);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setEncBusy(false);
    }
  };

  const onDecrypt = async () => {
    setDecBusy(true);
    try {
      const bytes = await getClient().transitDecrypt(mount, keyName, decryptIn.trim());
      try {
        setDecryptOut(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        // Plaintext wasn't valid UTF-8 (binary data) — show base64 as a graceful fallback.
        setDecryptOut(`(${bytes.length} bytes; not valid UTF-8)`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDecBusy(false);
    }
  };

  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-[var(--surface-raised)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <h3 className="font-display text-sm font-semibold">Playground</h3>
        <span className="text-[11px] text-muted-foreground">
          Try the key without leaving the page.
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="enc-in" className="flex items-center gap-1.5 text-[12px]">
            <Lock className="h-3 w-3" /> Encrypt
          </Label>
          <Input
            id="enc-in"
            value={plaintext}
            onChange={(e) => setPlaintext(e.target.value)}
            placeholder="plaintext (UTF-8)"
            className="font-mono"
          />
          <Button size="sm" onClick={onEncrypt} disabled={encBusy || plaintext.length === 0}>
            <Lock className="h-3 w-3" /> Encrypt
          </Button>
          {ciphertext ? (
            <div className="rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Ciphertext
              </p>
              <p className="mt-1 break-all font-mono text-[11px] leading-relaxed">{ciphertext}</p>
              <div className="mt-2 flex justify-end">
                <CopyButton value={ciphertext} label="Copy" autoClearSeconds={0} />
              </div>
            </div>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="dec-in" className="flex items-center gap-1.5 text-[12px]">
            <Unlock className="h-3 w-3" /> Decrypt
          </Label>
          <Input
            id="dec-in"
            value={decryptIn}
            onChange={(e) => setDecryptIn(e.target.value)}
            placeholder="vault:v1:…"
            className="font-mono"
          />
          <Button size="sm" onClick={onDecrypt} disabled={decBusy || decryptIn.trim().length === 0}>
            <Unlock className="h-3 w-3" /> Decrypt
          </Button>
          {decryptOut ? (
            <div className="rounded-[var(--radius-md)] border border-border bg-[var(--surface-inset)] p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Plaintext
              </p>
              <p className="mt-1 break-all font-mono text-[12px] leading-relaxed">{decryptOut}</p>
              <div className="mt-2 flex justify-end">
                <CopyButton value={decryptOut} label="Copy" autoClearSeconds={20} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div className="mt-6 flex items-center gap-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
      <TrustIndicator kind="verified">Engine A · Transit</TrustIndicator>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
        <Sparkles className="h-3 w-3" /> live · key material stays in OpenBao
      </span>
    </div>
  );
}

function CreateKeyDialog({
  onCreate,
}: {
  onCreate: (name: string, algorithm: string, exportable: boolean) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [algorithm, setAlgorithm] = React.useState<string>(ALGORITHMS[0]!.value);
  const [exportable, setExportable] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName("");
      setAlgorithm(ALGORITHMS[0]!.value);
      setExportable(false);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onCreate(name.trim(), algorithm, exportable);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" /> New key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a transit key</DialogTitle>
          <DialogDescription>
            Key material is generated inside the engine and never leaves it. Names are
            case-sensitive and form part of the ciphertext header — pick something stable.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tk-name">Name</Label>
            <Input
              id="tk-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="app-prod"
              className="font-mono"
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Algorithm</Label>
            <div className="grid gap-1.5">
              {ALGORITHMS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => setAlgorithm(a.value)}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-[var(--radius-md)] border px-3 py-2 text-left text-sm transition-colors",
                    algorithm === a.value
                      ? "border-primary/50 bg-primary/8"
                      : "border-border hover:border-[var(--border-strong)]",
                  )}
                >
                  <span className="font-medium">{a.label}</span>
                  <span className="text-[11px] text-muted-foreground">{a.hint}</span>
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={exportable}
              onChange={(e) => setExportable(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Exportable
              <span className="block text-[11px] text-muted-foreground">
                Allows reading the raw key material later. Off is recommended — turn on only if
                you genuinely need to export to an external system.
              </span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
