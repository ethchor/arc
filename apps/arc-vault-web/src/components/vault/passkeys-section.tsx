"use client";

import * as React from "react";
import { Fingerprint, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { browserPasskeyAuthenticator, type PasskeySummary, type VaultClient } from "@arc/sdk";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Inline section embedded in the SettingsDialog. Lists registered passkeys, lets the user
 * register a new one, and remove existing ones. All WebAuthn dialogs go through the
 * `browserPasskeyAuthenticator()` factory in @arc/sdk — the server never sees the PRF
 * output, only the wrapped envelopes.
 *
 * UX rules:
 *  - The PRF extension only works in Chrome 116+ / Safari 17+. We don't gate the button
 *    pre-emptively (feature-detect-by-trying is more reliable than userAgent sniffing);
 *    a failure surfaces the actual error in a toast.
 *  - Buttons show a Loader2 spinner during the WebAuthn round-trip; the OS dialog can be
 *    open for several seconds while the user touches a biometric sensor.
 *  - The label input is optional — defaults to nothing if the user just clicks "Add".
 */
export function PasskeysSection({ client }: { client: VaultClient }) {
  const [list, setList] = React.useState<PasskeySummary[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [label, setLabel] = React.useState("");

  const refresh = React.useCallback(async () => {
    try {
      setList(await client.listPasskeys());
    } catch (err) {
      toast.error("Couldn't load passkeys", { description: (err as Error).message });
    }
  }, [client]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const register = async () => {
    setBusy(true);
    try {
      const authenticator = browserPasskeyAuthenticator();
      await client.registerPasskey(authenticator, label.trim() || undefined);
      toast.success("Passkey added");
      setLabel("");
      await refresh();
    } catch (err) {
      toast.error("Couldn't add passkey", {
        description: explain((err as Error).message),
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await client.removePasskey(id);
      toast.success("Passkey removed");
      await refresh();
    } catch (err) {
      toast.error("Couldn't remove passkey", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div>
        <Label className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4" /> Passkeys
        </Label>
        <p className="text-xs text-muted-foreground">
          A passkey is an additive unlock path. Your master password still works.
        </p>
      </div>

      <div className="rounded-md border bg-muted/30">
        {list === null ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">Loading…</p>
        ) : list.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No passkeys registered yet.</p>
        ) : (
          <ul className="divide-y">
            {list.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.label ?? "Unnamed passkey"}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    Added {new Date(p.createdAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove passkey"
                  disabled={busy}
                  onClick={() => remove(p.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="passkey-label">Label (optional)</Label>
        <div className="flex gap-2">
          <Input
            id="passkey-label"
            placeholder="MacBook Touch ID"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
          <Button onClick={register} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Adding…
              </>
            ) : (
              "Add passkey"
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Requires a browser + authenticator with WebAuthn PRF support (Chrome 116+, Safari
          17+). Firefox doesn&apos;t ship PRF yet.
        </p>
      </div>
    </div>
  );
}

/** Map common WebAuthn error messages to friendlier copy. */
function explain(msg: string): string {
  if (/PRF/i.test(msg)) {
    return "Your browser or authenticator doesn't support the WebAuthn PRF extension. Try Chrome 116+ or Safari 17+.";
  }
  if (/cancel/i.test(msg)) return "You cancelled the OS prompt.";
  if (/not allowed/i.test(msg)) return "The browser blocked the request — check the page is on https or localhost.";
  return msg;
}
