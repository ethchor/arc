"use client";
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Code block with a copy-to-clipboard button. Server-side syntax highlighting is done
 * by `shiki` in the page component (see `highlightCode()`), which hands us pre-rendered
 * HTML. We keep the client surface minimal: copy state + the button.
 *
 * The `raw` prop is the text the copy button writes to the clipboard — it's separate
 * from `html` so the user copies plain code, not coloured `<span>` markup.
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

  return (
    <div className="my-4 overflow-hidden rounded-lg border bg-muted/30">
      {(filename || language) && (
        <div className="flex items-center justify-between border-b bg-muted/50 px-4 py-1.5 text-xs">
          <span className="font-mono text-muted-foreground">
            {filename ?? language}
          </span>
          {filename && language && (
            <span className="font-mono text-muted-foreground/70">{language}</span>
          )}
        </div>
      )}
      <div className="relative">
        <button
          type="button"
          aria-label="Copy to clipboard"
          onClick={copy}
          className={cn(
            "absolute right-3 top-3 z-10 rounded-md border bg-background/80 p-1.5 backdrop-blur",
            "text-muted-foreground transition-colors hover:bg-background hover:text-foreground",
            copied && "text-emerald-500"
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <div
          className="overflow-x-auto px-4 py-3 text-[13px] leading-6 [&_pre]:!bg-transparent"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
