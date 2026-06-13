import { codeToHtml } from "shiki";

/**
 * Server-side Shiki render. Called from page server components so the highlighted HTML
 * is in the initial response — no client-side highlight flash, no shipped highlighter
 * (Shiki is a heavy dep we don't want in the client bundle).
 *
 * We pick a built-in theme that pairs well with both our light + dark Tailwind themes;
 * Shiki's "github-dark-dimmed" and "github-light" are tuned for that.
 */
export async function highlightCode(
  code: string,
  language: string = "bash",
): Promise<string> {
  return codeToHtml(code.replace(/\n$/, ""), {
    lang: language,
    themes: {
      light: "github-light",
      dark: "github-dark-dimmed",
    },
    defaultColor: false, // emit `--shiki-light` / `--shiki-dark` CSS vars
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
