import type { ReactNode } from "react";
import Link from "next/link";
import { Github, Lock } from "lucide-react";
import { DocsSidebar } from "./components/docs-sidebar";

export const metadata = {
  title: "arc · documentation",
  description:
    "Public documentation for arc — the unified secrets platform combining infrastructure secrets and an end-to-end-encrypted vault.",
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center justify-between">
          <Link href="/docs" className="flex items-center gap-2 font-semibold tracking-tight">
            <Lock className="h-4 w-4 text-primary" />
            arc <span className="text-muted-foreground">/ docs</span>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/"
              className="hidden text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Web console
            </Link>
            <a
              href="https://github.com/ethchor/arc"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Github className="h-3.5 w-3.5" />
              GitHub
            </a>
          </div>
        </div>
      </header>

      <div className="container grid grid-cols-12 gap-6 py-8">
        <aside className="col-span-12 md:col-span-3 lg:col-span-3">
          <div className="md:sticky md:top-20">
            <DocsSidebar />
          </div>
        </aside>
        <main className="col-span-12 md:col-span-9 lg:col-span-9 max-w-3xl">
          <article className="prose prose-zinc max-w-none dark:prose-invert prose-headings:scroll-mt-20 prose-h1:text-3xl prose-h1:font-semibold prose-h1:tracking-tight prose-h2:mt-10 prose-h2:scroll-mt-20 prose-h2:border-b prose-h2:pb-2 prose-h2:text-xl prose-h2:font-semibold prose-h3:mt-6 prose-h3:text-base prose-h3:font-semibold prose-p:leading-7 prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none prose-pre:bg-transparent prose-pre:p-0">
            {children}
          </article>
        </main>
      </div>

      <footer className="border-t">
        <div className="container flex items-center justify-between py-6 text-xs text-muted-foreground">
          <span>arc — Apache 2.0</span>
          <Link href="/docs" className="hover:text-foreground">
            Back to docs index
          </Link>
        </div>
      </footer>
    </div>
  );
}
