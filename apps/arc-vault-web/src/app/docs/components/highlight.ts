import { codeToHtml } from "shiki";

/**
 * Server-side Shiki render. Called from page server components so the highlighted HTML
 * is in the initial response — no client-side highlight flash, no shipped highlighter
 * (Shiki is a heavy dep we don't want in the client bundle).
 *
 * Single dark theme on purpose: `CodeBlock` renders snippets in an always-dark terminal
 * window (macOS chrome), so the code reads identically in light and dark page themes.
 * `github-dark` is neutral near-black (#0d1117) — it sits cleanly under the orange brand
 * and matches the card surface in `code-block.tsx`. Inline `color:` per token (no CSS-var
 * switching needed), so colours are always correct without extra global CSS.
 */
export async function highlightCode(
  code: string,
  language: string = "bash",
): Promise<string> {
  return codeToHtml(code.replace(/\n$/, ""), {
    lang: language,
    theme: "github-dark",
  });
}

/** Render N snippets in one go — pages with many examples save a couple of awaits. */
export async function highlightAll<K extends string>(
  snippets: Record<K, { code: string; lang?: string }>,
): Promise<Record<K, string>> {
  const entries = await Promise.all(
    Object.entries(snippets).map(async ([k, v]) => {
      const s = v as { code: string; lang?: string };
      return [k, await highlightCode(s.code, s.lang)] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<K, string>;
}
