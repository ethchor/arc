"use client";

import { type CSSProperties, useState } from "react";
import type { PulledItem, VaultSummary } from "@arc-vault/sdk";
import { getClient, initClient, lock } from "../vault-store";

type Phase = "login" | "account" | "unlocked";

interface LoginData {
  type: "login";
  title: string;
  fields: { url: string; username: string; password: string };
}

export function VaultApp() {
  const [phase, setPhase] = useState<Phase>("login");
  const [baseUrl, setBaseUrl] = useState("http://localhost:3001");
  const [email, setEmail] = useState("");
  const [masterPassword, setMasterPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<PulledItem[]>([]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", url: "", username: "", password: "" });
  const [status, setStatus] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setStatus("");
    try {
      await fn();
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    }
  };

  const loadVaults = async () => setVaults(await getClient().listVaults());

  const doLogin = () =>
    run(async () => {
      initClient(baseUrl);
      await getClient().devLogin(email);
      setPhase("account");
    });

  const doEnroll = () =>
    run(async () => {
      const res = await getClient().enroll(masterPassword);
      setRecoveryKey(res.recoveryKey);
      await loadVaults();
      setPhase("unlocked");
    });

  const doUnlock = () =>
    run(async () => {
      await getClient().unlock(masterPassword);
      await loadVaults();
      setPhase("unlocked");
    });

  const createVault = () =>
    run(async () => {
      await getClient().createVault("team");
      await loadVaults();
    });

  const openVault = (id: string) =>
    run(async () => {
      setSelected(id);
      setRevealed(null);
      setItems((await getClient().pull(id, 0)).items.filter((i) => !i.deleted));
    });

  const addLogin = () =>
    run(async () => {
      if (!selected) return;
      await getClient().putItem(
        selected,
        {
          type: "login",
          title: form.title,
          fields: { url: form.url, username: form.username, password: form.password },
        },
        { type: "login" },
      );
      setForm({ title: "", url: "", username: "", password: "" });
      await openVault(selected);
    });

  const doLock = () => {
    lock();
    setPhase("login");
    setVaults([]);
    setItems([]);
    setSelected(null);
    setRecoveryKey(null);
    setMasterPassword("");
  };

  return (
    <main style={{ font: "14px system-ui, sans-serif", maxWidth: 560, margin: "40px auto", padding: 16 }}>
      <h1>arc-vault</h1>
      {status && <p style={{ color: "#b00" }}>{status}</p>}

      {phase === "login" && (
        <section>
          <h2>Sign in (sync authorization)</h2>
          <input placeholder="API base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={inp} />
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inp} />
          <button onClick={doLogin}>Sign in</button>
        </section>
      )}

      {phase === "account" && (
        <section>
          <h2>Unlock vault</h2>
          <p style={{ color: "#555" }}>Sign-in authorizes sync only; your master password never leaves this device.</p>
          <input
            type="password"
            placeholder="master password"
            value={masterPassword}
            onChange={(e) => setMasterPassword(e.target.value)}
            style={inp}
          />
          <button onClick={doUnlock}>Unlock</button>
          <button onClick={doEnroll} style={{ marginLeft: 8 }}>
            Enroll (new vault)
          </button>
        </section>
      )}

      {phase === "unlocked" && (
        <section>
          {recoveryKey && (
            <div style={{ background: "#fff7d6", padding: 12, border: "1px solid #e0c200" }}>
              <strong>Recovery key — store it now, shown once:</strong>
              <pre style={{ whiteSpace: "pre-wrap" }}>{recoveryKey}</pre>
            </div>
          )}
          <button onClick={doLock}>Lock</button>
          <h2>Vaults</h2>
          <button onClick={createVault}>+ New team vault</button>
          <ul>
            {vaults.map((v) => (
              <li key={v.id}>
                <button onClick={() => openVault(v.id)}>{v.type}</button> <small>{v.role}</small>
              </li>
            ))}
          </ul>

          {selected && (
            <section>
              <h3>Items</h3>
              <ul>
                {items.map((i) => {
                  const d = i.data as LoginData | null;
                  return (
                    <li key={i.id}>
                      {d?.title ?? i.id}{" "}
                      <button onClick={() => setRevealed(revealed === i.id ? null : i.id)}>
                        {revealed === i.id ? "hide" : "reveal"}
                      </button>
                      {revealed === i.id && d && (
                        <div style={{ color: "#333" }}>
                          <div>url: {d.fields.url}</div>
                          <div>username: {d.fields.username}</div>
                          <div>password: {d.fields.password}</div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <h4>Add login</h4>
              <input placeholder="title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={inp} />
              <input placeholder="https://site" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} style={inp} />
              <input placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} style={inp} />
              <input
                type="password"
                placeholder="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                style={inp}
              />
              <button onClick={addLogin}>Save</button>
            </section>
          )}
        </section>
      )}
    </main>
  );
}

const inp: CSSProperties = { display: "block", width: "100%", margin: "4px 0", padding: 6, boxSizing: "border-box" };
