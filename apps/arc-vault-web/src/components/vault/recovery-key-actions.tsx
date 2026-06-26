"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SPRING_SNAPPY } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Split a recovery key into 4-char chunks (strips the dashes/whitespace first). Shared so the
 *  enroll ceremony's chip grid and the print sheet group the key the same way. */
export function chunkRecoveryKey(recoveryKey: string | null | undefined): string[] {
  return (recoveryKey ?? "").replace(/[^A-Za-z0-9]/g, "").match(/.{1,4}/g) ?? [];
}

/**
 * Copy / Print / Download affordances for a recovery key, shared by the enrollment ceremony
 * ({@link EnrollScreen}) and the post-recovery banner ({@link RecoveryKeyCard}) so both offer
 * the exact same export options. Everything is built client-side from the key already in
 * memory — nothing is ever sent anywhere. The recovery key never leaves the device.
 */
export function RecoveryKeyActions({
  recoveryKey,
  className,
}: {
  recoveryKey: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const chunks = React.useMemo(() => chunkRecoveryKey(recoveryKey), [recoveryKey]);

  const copyKey = async () => {
    if (!recoveryKey) return;
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard can fail in non-secure contexts; the visual stays at "Copy" */
    }
  };

  const download = () => {
    if (!recoveryKey) return;
    // A formatted artifact (verbatim key + context + timestamp), not a bare dump. The
    // verbatim `recoveryKey` is the authoritative line so it can be pasted back exactly.
    const body = [
      "arc — recovery key",
      "",
      "This key is the only way back into your vault if you ever forget your",
      "master password. arc is zero-knowledge — we cannot recover it for you.",
      "",
      "RECOVERY KEY",
      recoveryKey,
      "",
      `Generated: ${new Date().toLocaleString()}`,
      "",
      "Keep this file offline and somewhere safe. Anyone with this key plus access",
      "to your account can unlock your vault. Don't email it or store it in another",
      "password manager.",
      "",
    ].join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "arc-recovery-key.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  // A dedicated, branded print sheet — honeycomb mark + the chunked key + a generation
  // timestamp + title/description/warning — instead of printing the live React component.
  // Built entirely client-side from the key already in memory; nothing is sent anywhere.
  const printRecoveryKey = () => {
    if (!recoveryKey || chunks.length === 0) return;
    const win = window.open("", "_blank", "width=760,height=960");
    if (!win) return; // popup blocked — Copy / Download remain available
    const origin = window.location.origin;
    const mark = `${origin}/arc-honeycomb.svg`;
    const generated = new Date().toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
    const cells = chunks.map((c) => `<span class="cell">${c}</span>`).join("");
    win.document.write(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>arc · recovery key</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; color: #0C0F16; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  .sheet { max-width: 560px; margin: 0 auto; padding: 56px 48px; }
  .head { display: flex; align-items: center; gap: 14px; padding-bottom: 26px; border-bottom: 1px solid #E6E8EC; }
  .mark { width: 50px; height: 50px; flex: none; display: inline-block; background: #14AE9B;
    -webkit-mask: url("${mark}") center / contain no-repeat; mask: url("${mark}") center / contain no-repeat; }
  .brand { display: flex; flex-direction: column; line-height: 1.1; }
  .word { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  .kicker { font-size: 11px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #14AE9B; margin-top: 4px; }
  h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; margin: 32px 0 10px; }
  .lede { font-size: 14px; color: #4A5160; margin: 0 0 24px; max-width: 48ch; }
  .keybox { border: 1px solid #E6E8EC; border-radius: 12px; background: #F6F7F9; padding: 18px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .cell { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 16px; font-weight: 600;
    letter-spacing: 0.08em; text-align: center; padding: 12px 4px; background: #fff; border: 1px solid #E6E8EC; border-radius: 8px; color: #0C0F16; }
  .meta { font-size: 12px; color: #6B7280; margin: 14px 2px 0; }
  .note { margin: 28px 0 0; padding: 16px 18px; border: 1px solid #F0D9A8; background: #FBF4E4; border-radius: 10px; font-size: 13px; color: #5C4A1E; }
  .note strong { display: block; margin-bottom: 4px; color: #3F3413; }
  .foot { margin-top: 38px; padding-top: 18px; border-top: 1px solid #E6E8EC; font-size: 12px; color: #9AA1AD; }
  @page { margin: 16mm; }
  @media print { .sheet { padding: 8px 4px; } }
</style>
</head>
<body>
  <main class="sheet">
    <header class="head">
      <span class="mark" aria-hidden="true"></span>
      <span class="brand"><span class="word">arc</span><span class="kicker">recovery key</span></span>
    </header>
    <h1>Your arc recovery key</h1>
    <p class="lede">This key is the only way back into your vault if you ever forget your master password. arc is zero-knowledge, so we can't recover it for you — this sheet is your backup.</p>
    <section class="keybox" aria-label="recovery key"><div class="grid">${cells}</div></section>
    <p class="meta">Generated ${generated}</p>
    <section class="note"><strong>Keep this sheet offline and somewhere safe.</strong>Anyone who has this key and access to your account can unlock your vault. Don't photograph it, email it, or store it in another password manager.</section>
    <footer class="foot">arc — one key, held only by you.</footer>
  </main>
  <script>
    (function () {
      var done = false;
      function go() { if (done) return; done = true; try { window.focus(); } catch (e) {} window.print(); }
      var img = new Image();
      img.onload = go; img.onerror = go; img.src = ${JSON.stringify(mark)};
      setTimeout(go, 800);
      window.onafterprint = function () { window.close(); };
    })();
  <\/script>
</body>
</html>`);
    win.document.close();
  };

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      <Button variant="secondary" size="sm" onClick={copyKey}>
        <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
          <AnimatePresence mode="wait" initial={false}>
            {copied ? (
              <motion.span
                key="copied"
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={SPRING_SNAPPY}
                className="absolute inset-0 flex items-center justify-center"
              >
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              </motion.span>
            ) : (
              <motion.span
                key="copy"
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={SPRING_SNAPPY}
                className="absolute inset-0 flex items-center justify-center"
              >
                <Copy className="h-3.5 w-3.5" />
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        {copied ? "Copied" : "Copy"}
      </Button>
      <Button variant="secondary" size="sm" onClick={printRecoveryKey}>
        <Printer className="h-3.5 w-3.5" /> Print
      </Button>
      <Button variant="secondary" size="sm" onClick={download}>
        <Download className="h-3.5 w-3.5" /> Download
      </Button>
    </div>
  );
}
