"use client";
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Code block styled as a macOS-style terminal window: traffic-light dots, a filename /
 * language label, and a copy button, over an always-dark surface so snippets read the
 * same in light and dark page themes (the Shiki output is a single dark theme).
 *
 * `not-prose` detaches the block from the docs `article.prose` typography — otherwise
 * the inline-code `background` rule bleeds onto the highlighted `<code>` and fragments
 * into a pill behind every wrapped line.
 *
 * The `raw` prop is what the copy button writes to the clipboard — separate from `html`
 * so the user copies plain code, not coloured `<span>` markup.
 */
export function CodeBlock({
  html,
  raw,
  language,
  filename,
}: {
  html: string;
  raw: string;
  language?: string;
  filename?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
    } catch {
      // clipboard write can fail in non-secure contexts; the visual stays at "Copy"
    }
  };

  const label = filename ?? language;

  return (
    <div className="not-prose group my-5 overflow-hidden rounded-xl bg-[#0d1117] shadow-[var(--shadow-md)] ring-1 ring-white/10">
      {/* Window chrome */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        {label ? (
          <span className="truncate font-mono text-xs text-white/45">{label}</span>
        ) : null}
        <button
          type="button"
          aria-label="Copy to clipboard"
          onClick={copy}
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
            "text-white/45 transition-colors [transition-duration:var(--dur-fast)]",
            "hover:bg-white/[0.06] hover:text-white/80",
            copied && "text-emerald-400",
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      {/* Highlighted body — reset every prose remnant, force transparent so the card bg shows. */}
      <div
        className={cn(
          "overflow-x-auto px-4 py-3.5 text-[13px] leading-[1.65]",
          "[&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0",
          "[&_code]:!bg-transparent [&_code]:!p-0 [&_code]:![font-size:inherit]",
          "[&_.line]:!bg-transparent",
        )}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
