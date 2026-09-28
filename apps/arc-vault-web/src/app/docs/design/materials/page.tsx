import { Bell, Copy, KeyRound, Lock, MoreHorizontal, Plus, Search, Share, ShieldCheck, Trash2 } from "lucide-react";
import { Callout } from "../../components/callout";
import { DocsPrevNext } from "../../components/docs-prev-next";

export const metadata = { title: "Materials · arc docs" };

const tokens: { name: string; use: string }[] = [
  { name: ".glass", use: "Regular glass: toolbar groups, the compact tab bar, capsules with a few controls." },
  { name: ".glass-strong", use: "More opaque glass for large or text-dense surfaces: sidebar, sheets, menus, popovers, tooltips, toasts." },
  { name: ".glass-prominent", use: "The one primary action per view. The accent tints the background, never the label." },
  { name: ".scroll-edge", use: "The soft blur-and-fade under a floating bar, so controls stay distinct from content scrolling beneath." },
  { name: "--glass-inset", use: "The 8px gap between floating chrome and the viewport edge." },
  { name: "--radius-2xl", use: "22px outer corner for floating chrome; nested shapes use it minus their inset (concentric)." },
];

const rules = [
  "Glass is the functional layer only: navigation, toolbars, menus, sheets, toasts. Content (rows, cards, forms, revealed secrets) never sits on glass.",
  "Labels on glass stay monochrome. Only the primary action gets the accent, as a tinted background.",
  "Large surfaces use the strong fill; don't stack glass on glass.",
  "Unlock, master-password entry, recovery keys and revealed values stay on opaque surfaces.",
  "Reduce Transparency (system setting where the browser exposes it, or Appearance → Reduce Transparency) and Increase Contrast make every glass surface opaque.",
];

/** A static stage showing every glass surface over real content, for review in each appearance. */
function Stage() {
  return (
    <div
      role="img"
      aria-label="Preview of arc's glass surfaces: a sidebar, a toolbar, a menu, a primary button and a toast floating over vault content."
      className="bg-arc-mesh relative h-[440px] overflow-hidden rounded-[var(--radius-2xl)] border"
    >
      <div aria-hidden className="absolute inset-0 grid grid-cols-3 gap-3 p-6 pt-20 opacity-95">
        {["Production DB", "Stripe webhook", "GitHub deploy key", "AWS STS", "Office Wi-Fi", "Recovery codes"].map((t, i) => (
          <div key={t} className="rounded-[var(--radius-lg)] border bg-card p-4 shadow-[var(--shadow-sm)]">
            <div className="mb-3 h-16 rounded-[var(--radius-md)]" style={{ background: ["#2DC6B1", "#EC9B2E", "#6E83F5", "#36C97B", "#F26464", "#9AA4B4"][i] }} />
            <div className="text-sm font-medium">{t}</div>
            <div className="font-mono text-xs text-muted-foreground">••••••••••••</div>
          </div>
        ))}
      </div>
      <div aria-hidden className="scroll-edge absolute inset-x-0 top-0 h-24" />
      <div aria-hidden className="absolute inset-x-3 top-3 flex items-center gap-2">
        <div className="glass flex h-11 items-center gap-2 rounded-full pl-4 pr-4 text-headline">My Vault</div>
        <div className="flex-1" />
        <div className="glass flex h-11 w-60 items-center gap-2 rounded-full px-4 text-sm text-muted-foreground">
          <Search className="h-4 w-4" /> Search
        </div>
        <div className="glass flex h-11 items-center gap-1 rounded-full px-2 text-foreground/80">
          <Bell className="m-1.5 h-4 w-4" />
          <Share className="m-1.5 h-4 w-4" />
          <Lock className="m-1.5 h-4 w-4" />
        </div>
        <div className="glass glass-prominent flex h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold">
          <Plus className="h-4 w-4" /> New Item
        </div>
      </div>
      <div aria-hidden className="glass glass-strong absolute bottom-16 right-8 w-56 rounded-[var(--radius-lg)] p-1 text-sm">
        {[[Copy, "Copy Password"], [Share, "Share…"], [KeyRound, "Rotate Key…"]].map(([Icon, label]) => {
          const I = Icon as typeof Copy;
          return (
            <div key={label as string} className="flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 first:bg-foreground/[0.08]">
              <I className="h-4 w-4" /> {label as string}
            </div>
          );
        })}
        <div className="-mx-1 my-1 h-px bg-border/60" />
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-destructive">
          <Trash2 className="h-4 w-4" /> Erase…
        </div>
      </div>
      <div aria-hidden className="glass glass-strong absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-[var(--radius-xl)] px-4 py-2.5 text-sm">
        <ShieldCheck className="h-4 w-4 text-primary" /> Copied — clears in 30 s
        <MoreHorizontal className="ml-2 h-4 w-4 text-muted-foreground" />
      </div>
    </div>
  );
}

export default function MaterialsPage() {
  return (
    <article className="prose prose-slate max-w-none dark:prose-invert">
      <h1>Materials</h1>
      <p className="lead">
        arc&apos;s interface follows Apple&apos;s Liquid Glass model: controls and navigation float in a glass
        layer above your content. On the web there&apos;s no system material, so arc builds it from CSS. See{" "}
        <code>docs/18-apple-hig-liquid-glass.md</code> for the full plan.
      </p>
      <div className="not-prose my-6">
        <Stage />
      </div>
      <p>
        Switch between light and dark (Appearance menu or your system setting), and try Reduce Transparency and
        Increase Contrast: every surface above should stay legible, and turn opaque when transparency is reduced.
      </p>
      <h2>Rules</h2>
      <ul>
        {rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <h2>Tokens and utilities</h2>
      <div className="not-prose overflow-x-auto rounded-[var(--radius-lg)] border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-4 py-2 font-semibold">Name</th>
              <th className="px-4 py-2 font-semibold">Use</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.name} className="border-t">
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{t.name}</td>
                <td className="px-4 py-2 text-muted-foreground">{t.use}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Callout>
        Glass costs GPU time. arc keeps at most four blurred surfaces on screen and never puts glass on list rows.
      </Callout>
      <DocsPrevNext href="/docs/design/materials" />
    </article>
  );
}
