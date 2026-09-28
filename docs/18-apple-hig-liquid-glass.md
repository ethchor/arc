# 18 — Apple HIG (2026) and Liquid Glass: adoption plan for the web app

**Status:** `[planned]` · **Scope:** `apps/arc-vault-web` (the console, unlock and enrolment
screens, and `/docs`). The Tauri desktop app shares this frontend and gets extra native
treatment in §4.8. **Sources:** every page of Apple's Human Interface Guidelines, current
through its 17 September 2026 change log (172 pages, crawled 28 September 2026), and
Apple's [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
guide.

This document does three things:

- It translates the 2026 HIG, including the iOS 27-cycle updates, into web terms.
- It specifies how arc renders Liquid Glass in a browser, where there is no system material
  to inherit.
- It maps the guidance onto arc's actual components, in phases with acceptance criteria.

Appendix A gives a disposition for every HIG page in Foundations, Patterns, Components,
Inputs and Technologies, so nothing is silently skipped.

---

## 0. Summary

- **Liquid Glass is a layer, not a skin.** Apple uses it only for the *functional layer*:
  navigation, toolbars, tab bars, sidebars, sheets, popovers, menus, and controls while
  they're being manipulated. Content never sits on glass. For arc, the sidebar, toolbar,
  compact tab bar, command palette, menus, popovers, sheets and toasts become glass. Vault
  items, tables, forms and every security-critical surface stay on opaque content materials.
- **The web has no glass API, so arc builds one.** The mechanism is CSS `backdrop-filter`
  blur and saturation, a specular rim, and theme-aware translucent fills. It ships with
  fallbacks for reduced transparency, increased contrast and unsupported browsers, and with
  a performance budget. Refraction (the "liquid" lensing) is Chromium-only on the web and
  stays an optional enhancement.
- **Brand moves into the content layer.** The September 2026 Branding update and the
  Liquid Glass color rules both say the accent color belongs on the primary action,
  selection and status. The expressive color belongs *under* the glass, where the glass
  picks it up. arc's cyan/ember mesh already works this way; the plan makes it
  deliberate.
- **The biggest structural gap is compact screens.** The console sidebar is always
  visible (232 px, or 60 px collapsed) with no compact adaptation. The HIG pattern is a
  floating tab bar at compact widths that converts to the sidebar at regular widths. The
  new iPhone Duo guidance adds fold-safe layouts.
- **Security UI keeps its gravity.** Unlock, master-password entry, recovery keys,
  revealed secrets and trust indicators stay on opaque, high-contrast surfaces. arc never
  styles its own dialogs to resemble OS authentication or permission prompts.
- Six decisions need an owner before Phase 1 (§8).

## 1. What the 2026 HIG changed

The 2026 change logs list these updates. Rows marked ★ change arc's plan directly.

| Date | Page | Change | Impact on arc |
| --- | --- | --- | --- |
| 8 Jun 2026 | Design principles ★ | Reintroduced: Purpose, Agency, Responsibility, Familiarity, Flexibility, Simplicity, Craft, Delight | These eight principles are the review checklist for every redesigned view (§3). |
| 8 Jun 2026 | Menus ★ | Updated guidance for menu-item icons | Icons for common actions, applied uniformly per group (§4.4). |
| 8 Jun 2026 | Scroll views ★ | Updated scroll-edge-effect guidance | Floating toolbars sit over a scroll-edge effect, not a solid bar (§2.2). |
| 8 Jun 2026 | Sidebars ★ | Sidebar icon colors; the adaptable sidebar style | Icons use the accent color, with fixed colors only when meaningful (§4.1). |
| 8 Jun 2026 | Tab bars · Search fields · Searching ★ | Terminology and art; search as a tab | A trailing search tab on compact screens (§4.2, §4.5). |
| 8 Jun 2026 | App icons | Refined Liquid Glass icon guidance | PWA and desktop icon refresh (§4.9). |
| 8 Jun 2026 | Generative AI ★ | Refining results, feedback during generation, choosing a model | The Engine C agents console (§4.10). |
| 8 Jun 2026 | Snippets (new) · Siri · App Shortcuts · Wallet · Apple Pay | Native-only additions | Not applicable to a web app (Appendix A). |
| 24 Mar 2026 | Sheets ★ | Button placement | Cancel leading, Done trailing; never show Cancel, Done and Back together (§4.4). |
| 9 Sep 2026 | Branding ★ | Refined guidance for brand color | Accent color sparingly; brand color in the content layer (§3.1). |
| 9 Sep 2026 | Layout ★ | Current best practices | Separate controls from content with glass plus a scroll-edge effect; backgrounds extend beneath sidebars (§4.1). |
| 9 Sep 2026 | Designing for iPhone Duo (new) ★ | Dual displays, device poses, reserved regions, side-placed bars | Fold-safe, resize-first responsive layout (§4.2). |
| 9 Sep 2026 | SharePlay | Reorganized | Not applicable. |
| 17 Sep 2026 | Apple In-App Purchase | Rebrand | Not applicable. |

Liquid Glass itself arrived in June 2025 (Materials, Color and most components) and was
refined in September 2025. The 2026 updates build on it rather than replacing it.

Xcode 27's bundled agent skills (for example, the SwiftUI toolbar notes on visibility
priority, the overflow menu, pinned trailing items and minimize-on-scroll) confirm the
toolbar behaviors adopted in §4.1. They are Apple-licensed and native-only, so arc only
references them and doesn't vendor them.

## 2. Liquid Glass on the web

### 2.1 Rules arc adopts

These rules come from Materials, Color, Layout, Scroll views and Adopting Liquid Glass.

1. **Glass is for the functional layer only.** Use it for navigation, toolbars, tab bars,
   sidebars, sheets, popovers, menus and toasts. Content (rows, cards, forms, the item
   detail, charts) uses the standard content materials. The one exception is a control's
   *transient* state: a toggle or slider knob may turn to glass while it's being dragged.
2. **Use it sparingly.** Style only the most important functional elements, and don't
   stack glass on glass.
3. **There are two variants.** *Regular* glass blurs and adjusts luminosity for legibility,
   and is the default. *Clear* glass is highly translucent and is used only over visually
   rich media. Over bright content, clear glass gets a **35% dark dimming layer**. arc has
   almost no media, so it effectively uses regular glass only.
4. **Large surfaces are more opaque.** Apple renders sidebars more opaque than small bars
   "to preserve legibility over complex backgrounds". arc has two fills: `glass` for bars
   and capsules, and `glass-strong` for the sidebar and sheets.
5. **Glass has no inherent color.** Labels on glass are monochrome and adapt to what's
   underneath. Only the primary action gets color, as a tinted *background* (prominent
   glass), and never more than one control per view.
6. **The scroll edge effect replaces solid bars.** Where content scrolls beneath a floating
   bar, add one scroll-edge effect per pane. It is not decoration: use it only where
   something floats over scrolling content.
7. **Corners are concentric.** Nested shapes share a center, so each inner radius equals
   the outer radius minus the inset.
8. **Hide or overflow whole items,** never empty containers. If a toolbar item has nothing
   to show, remove the item rather than rendering an empty capsule.

### 2.2 Implementation

A token set and three utilities go in `globals.css` (`@layer base` and `@layer components`),
next to the existing design-system tokens.

```css
:root {                                   /* light */
  --glass-fill:        rgb(255 255 255 / 0.56);
  --glass-fill-strong: rgb(255 255 255 / 0.80);   /* sidebar, sheets: more opaque (HIG) */
  --glass-rim:         rgb(255 255 255 / 0.70);   /* specular top edge */
  --glass-edge:        rgb(20 24 33 / 0.10);      /* hairline against content */
  --glass-shadow:      0 8px 32px rgb(20 24 33 / 0.12);
  --glass-blur:        22px;
  --glass-saturate:    170%;
  --glass-dim:         rgb(0 0 0 / 0.35);         /* HIG: dim bright content under clear glass */
  --scroll-edge-h:     56px;
}
.dark {
  --glass-fill:        rgb(20 24 33 / 0.58);      /* #141821 at 58% */
  --glass-fill-strong: rgb(20 24 33 / 0.82);
  --glass-rim:         rgb(255 255 255 / 0.14);
  --glass-edge:        rgb(0 0 0 / 0.55);
  --glass-shadow:      0 14px 40px rgb(0 0 0 / 0.50);
}

@layer components {
  .glass {
    background: var(--glass-fill);
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
            backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    border: 1px solid var(--glass-edge);
    box-shadow: inset 0 1px 0 var(--glass-rim), var(--glass-shadow);
    contain: paint;                           /* keep repaint cost local */
  }
  .glass-strong   { background: var(--glass-fill-strong); }
  .glass-prominent {                          /* the single primary action per view */
    background: color-mix(in oklab, hsl(var(--primary)) 90%, transparent);
    color: hsl(var(--primary-foreground));
  }
  /* Scroll edge effect: a blurred fade under a floating bar, not a solid band. */
  .scroll-edge-top {
    position: sticky; top: 0; z-index: 1; pointer-events: none;
    height: var(--scroll-edge-h); margin-bottom: calc(-1 * var(--scroll-edge-h));
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    background: linear-gradient(to bottom, hsl(var(--background) / 0.7), transparent);
    -webkit-mask-image: linear-gradient(to bottom, #000 45%, transparent);
            mask-image: linear-gradient(to bottom, #000 45%, transparent);
  }
}

/* Fallbacks: no support, reduced transparency, increased contrast. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass { background: var(--glass-fill-strong); }
}
@media (prefers-reduced-transparency: reduce) {
  .glass, .scroll-edge-top { -webkit-backdrop-filter: none; backdrop-filter: none; }
  .glass { background: hsl(var(--popover)); }
}
@media (prefers-contrast: more) {
  .glass { -webkit-backdrop-filter: none; backdrop-filter: none; background: hsl(var(--popover));
           border-color: hsl(var(--foreground) / 0.45); box-shadow: none; }
}
```

**Concentric radii.** The DS radius scale already exists (`--radius-*`, 4 to 22 px). Floating
chrome uses `--radius-2xl` (22 px) at an 8 px inset from the viewport. Anything nested
inside uses `calc(var(--radius-2xl) - <inset>)`, clamped to at least `--radius-sm`, through
one `.concentric` helper, so the curvature stays consistent without hand-tuned radii.

**Grouping.** SwiftUI's `GlassEffectContainer` merges nearby glass shapes for performance.
The web equivalent is one glass capsule per toolbar *group*, with plain buttons inside it
rather than a backdrop filter on every button. That caps the number of backdrop layers the
compositor blends.

**Refraction and lensing** (optional, later). An SVG `feDisplacementMap` referenced from
`backdrop-filter: url(#lens)` produces Apple-like edge refraction, but only Chromium
renders it. If it's ever tried, it goes behind `@supports`, only on the compact tab bar,
never on text-heavy surfaces, and has to pass the performance budget.

### 2.3 Color on and under glass

- **Glass carries no color.** Labels and icons on glass use `--content-primary` and
  `--content-secondary`, not the accent.
- **The accent (arc cyan `--ds-accent`) appears on four things:** the one prominent action
  per view, the current selection (sidebar item, selected tab icon), focus rings, and
  status that needs it. Ember stays on warnings and the agent role, as today.
- **The brand mesh (`.bg-arc-mesh`, cyan and ember radial glows) is content-layer
  background** and extends under the sidebar and toolbar, so the glass picks it up. This
  is the HIG's "move brand color into the content layer".
- **Resting states must stay legible** even though colorful content may scroll under
  controls. At the top of every scrollable view, check label contrast on glass in light
  mode, dark mode and increased contrast.
- **Every token needs light, dark and increased-contrast values** (Color, Dark Mode,
  Adopting Liquid Glass). Today's DS tokens cover light and dark; Phase 0 adds
  `@media (prefers-contrast: more)` overrides.

### 2.4 Accessibility

| HIG requirement | Web implementation for arc |
| --- | --- |
| Contrast of 4.5:1 for text up to 17 pt, 3:1 at 18 pt or bold | Axe checks in CI for opaque surfaces, plus screenshot-based luminance checks for text on glass over the mesh, which contrast tools can't compute through a backdrop. |
| Controls 44×44 pt by default (28 minimum) on iOS; 28×28 (20 minimum) on macOS | 44 px hit targets under `(pointer: coarse)` and 28 px under `(pointer: fine)`; padding extends the hit region, not the visual. |
| Reduce Transparency, Increase Contrast | `prefers-reduced-transparency` makes glass opaque, `prefers-contrast: more` makes it opaque with a stronger border. Browsers don't all expose reduced transparency yet, so the appearance menu gets a "Reduce transparency" fallback (decision D3). |
| Reduce Motion | `prefers-reduced-motion`: morphs become fades, and the pulsing status dot stops. |
| Keyboard alone | Full keyboard reach for every control, visible `:focus-visible` rings on fields, highlight focus in lists, standard shortcuts untouched, ⌘K kept. |
| VoiceOver / screen readers | An accessible name on every icon-only toolbar and tab item (the HIG requires a label even when only the icon shows); live regions for lease expiry and sync status. |
| Larger text | rem-based type everywhere, layouts that stack at large sizes, minimal truncation (§3.2). |

### 2.5 Motion

- **Buttons "morph" into menus and popovers.** A menu or popover grows from its trigger's
  bounds using `motion` layout animation (already a dependency) or same-document View
  Transitions where supported, over 220–320 ms with the DS `--ease-out-expo`. Under reduced
  motion it becomes a 120 ms fade.
- **Toggle and slider knobs take on glass while dragged** (the transient-interactivity
  exception) and return to solid on release.
- **The compact tab bar minimizes on scroll down and restores on scroll up,** which is
  opt-in in the HIG. The minimized state keeps the current tab and search reachable.
- **No motion on high-frequency interactions** such as row hover and typing (Motion:
  "generally avoid adding motion to UI interactions that occur frequently").

### 2.6 Performance budget

- **At most four backdrop-filtered surfaces on screen at once:** sidebar, toolbar, and one
  transient (menu, popover or sheet), plus toasts. List rows never get glass.
- **No frame drops while scrolling** the vault list and audit log at 60 fps. The reference
  devices are a 2021 mid-range Android phone (Chrome) and an iPhone 12 (Safari), with
  traces recorded in Phase 0 and repeated per phase.
- **`backdrop-filter` stays off layers that animate every frame.** Animate `transform` and
  `opacity` on a child, never the filter itself.
- **Low-end fallback.** Under `(prefers-reduced-motion: reduce)` or when a frame-time probe
  detects a device that can't keep up, the blur radius halves and saturation is dropped.

### 2.7 What arc won't do

- **Imitate Apple system UI.** No lookalike Face ID sheets, permission alerts or macOS
  window chrome. A password manager that mimics OS auth UI trains people to trust fakes.
  Passkey and biometric prompts always come from the browser or OS via WebAuthn.
- **Ship SF Symbols or SF fonts.** The SF Symbols terms prohibit, among other things, use
  in logos, and the HIG says not to embed the system fonts. arc uses Lucide icons and
  requests the system font through `system-ui` where decision D2 chooses it.
- **Apply glass to content,** security-critical surfaces, or anything behind a revealed
  secret. The next section covers this.

**Guardrail: security surfaces stay opaque.** The unlock and enrolment forms, the master-password field,
the recovery-key sheet, revealed values in `MaskedField`, `TrustIndicator`s, and
destructive confirmations use `--surface-raised` or `--surface-inset`, never glass. They
stay fully legible under every setting, and the only thing behind them is their own
content.

## 3. Foundations applied to arc

Use the reintroduced **design principles** as the review rubric for every PR in this
program:
- Purpose: does the view serve its task?
- Agency: can people recover, and do they stay in control?
- Responsibility: is it transparent and privacy-safe?
- Familiarity: are the patterns standard?
- Flexibility: does it work at every size, input method and setting?
- Simplicity: does every element earn its place?
- Craft: are the details finished?
- Delight: is it human without being decoration?

### 3.1 Branding and color

- **The honeycomb mark stays in exactly two places:** the sidebar header tile (the console
  nav rail lockup) and the unlock and enrolment brand panel. Don't repeat the logo
  elsewhere (Branding: "resist the temptation to display your logo throughout your app").
- **The accent stays cyan and is used as §2.3 describes.** The theme presets (violet, slate
  and others in `theme-customizer.tsx`) conflict with a single brand accent and with Dark
  Mode's "avoid app-specific appearance settings" (decision D3).
- **Voice:** direct, calm and precise, as a security product should be. Plain words, no
  exclamation marks in errors, and the "zero-knowledge" language kept truthful, as today.
- **Fix the brand-panel grid.** It currently reads the theme's `--border`, so in light mode
  the grid is bright and cuts through the panel's text. Pin it to the dark palette.

### 3.2 Typography

HIG reference sizes are 17 pt Body on iOS with an 11 pt minimum, and 13 pt Body on macOS
with a 10 pt minimum. arc's proposed tokens are rem-based, so browser and OS text-size
settings scale them.

| arc token | Compact (touch) | Regular (pointer) | HIG counterpart (iOS / macOS) |
| --- | --- | --- | --- |
| `text-large-title` | 34/41, bold | 26/32, bold | Large Title 34/41 · 26/32 |
| `text-title-1` | 28/34 | 22/26 | Title 1 28/34 · 22/26 |
| `text-title-2` | 22/28 | 17/22 | Title 2 22/28 · 17/22 |
| `text-title-3` | 20/25, semibold | 15/20, semibold | Title 3 20/25 · 15/20 |
| `text-headline` | 17/22, semibold | 14/20, semibold | Headline 17/22 · 13/16 |
| `text-body` | 17/22 | 14/20 | Body 17/22 · 13/16 |
| `text-callout` | 16/21 | 13/18 | Callout 16/21 · 12/15 |
| `text-subhead` | 15/20 | 12/16 | Subhead 15/20 · 11/14 |
| `text-footnote` | 13/18 | 11/14 | Footnote 13/18 · 10/13 |
| `text-caption` | 12/16 | 11/14 | Caption 1 12/16 · 10/13 |

Desktop Body is set at 14 px rather than macOS's 13 pt because web text renders without
AppKit's optical tuning. It stays at or above the macOS minimum.

- **Weights:** no light weights anywhere (Typography: "avoid light font weights").
- **Families (decision D2):** keep Space Grotesk for display text (titles), which is brand
  expression the HIG explicitly allows. Either keep IBM Plex Sans for UI text, or move body
  and control text to `system-ui`, which gives SF on Apple devices, Segoe UI on Windows and
  Roboto on Android. Geist Mono stays for secrets, paths and code.
- **Dynamic Type on iOS Safari:** under `@supports (font: -apple-system-body)` and
  `(pointer: coarse)`, set `html { font: -apple-system-body }` so the root size follows the
  iOS text-size setting, then restore `font-family` from the stack. Every rem scales with it.
  Validate at the largest accessibility size, where layouts should stack and not truncate.
- **Title-style capitalization** for menu items, buttons, section headers, tab labels and
  view titles. Sentence case for descriptions, tooltips and alert bodies. Remove the CSS
  `uppercase` from the sidebar group labels (they become "Engine A · Infrastructure", not
  "ENGINE A · INFRASTRUCTURE").

### 3.3 Layout, Dark Mode, RTL and writing

- **Size classes become container queries.** *Compact* is under 600 px of container width
  and *regular* is 600 px or more. Layout decisions use the available width, never the
  device type (Layout: "determine layout based on size classes, not device type").
- **Safe areas:** `viewport-fit=cover` plus `env(safe-area-inset-*)` on the floating
  chrome. Content extends beneath the bars.
- **Dark Mode:** default to `system`. Every custom color has light and dark variants, with
  increased-contrast overrides.
- **RTL:** CSS logical properties everywhere (`ms-*`/`me-*`, `inset-inline`), with
  directional icons mirrored.
- **Writing:** one capitalization rule set (§3.2), verb-first button and menu labels, an
  ellipsis when more input follows, empty states that always offer a next step, and error
  messages that say what happened and what to do.

## 4. Component-by-component plan

### 4.1 Console shell: sidebar, toolbar and split view

This covers `components/vault/console-shell.tsx`, `command-palette.tsx` and `site-header.tsx`.

**Sidebar**
- **It floats.** The sidebar gets `glass-strong`, inset 8 px from the viewport edges, with
  a `--radius-2xl` capsule and concentric inner radii. The content column extends beneath
  it: the mesh background runs full-bleed, and wide hero content can use a mirrored,
  blurred "background extension" strip under it.
- **Structure:** at most two levels. Group labels switch to title case, and the icons use
  the accent color, which is the HIG's sidebar default. The selected row is a filled,
  concentric highlight rather than an edge marker.
- **The existing collapse-to-rail becomes "hide sidebar",** with the same toggle (and the
  macOS-standard ⌃⌘S in Phase 2).
  Auto-collapse below about 1100 px. Nothing critical sits at the bottom of the sidebar.
- **Persona switch (Personal/Operator):** a two-segment segmented control at the top of the
  sidebar, not a dropdown.

**Toolbar (the header)**
- **Replace the solid `bg-background/85` band** with glass capsule groups over a
  `.scroll-edge-top`. Title-plus-navigation goes on the leading edge, contextual actions in
  the center, and search, the inspector toggle, the primary action and More on the
  trailing edge.
- **At most three groups.** Icon-only items have accessible names and no borders, and
  never mix text and icon items in one capsule.
- **The view's single primary action uses `glass-prominent`** on the trailing edge (for
  example, "New item" in the vault, "Issue" in PKI).
- **Overflow follows the iOS 27 visibility-priority model:** each toolbar group declares a
  priority, and as width shrinks the lowest groups move into the trailing More menu.
  Leading navigation and the trailing primary action never overflow.
- **View titles stay under 15 characters and never use the app name.** "My vault", "Leases"
  and "Audit log" already comply.

**Split view:** at regular widths, the vault, leases and audit views gain a list plus
inspector layout. The inspector is a content-layer panel, not glass, so selection
highlighting persists in the list. It collapses to push navigation at compact widths.

### 4.2 Responsive navigation: tab bar, adaptable sidebar, iPhone Duo

- **Compact widths (under 600 px) get a floating glass tab bar** at the bottom, inset from
  the edges and above the home indicator via safe-area insets. It has five tabs or fewer
  per persona (decision D4 proposes "Personal: Home · Vault · Security · Devices · Search"
  and "Operator: KV · Creds · Leases · Audit · Search"). A leading button in the tab bar
  converts it into the full sidebar, as a sheet (the HIG's sidebar-adaptable pattern).
- **Search is the trailing tab.** Tabs are never hidden or disabled; an empty section
  explains itself.
- **The tab bar minimizes on scroll** (§2.5). Toolbars move to the top on compact widths,
  with a large title that collapses on scroll.
- **Wide-and-short viewports get side-placed bars.** Following iPhone Duo's vertical
  controls, when `(max-height: 500px) and (orientation: landscape)` the tab bar and toolbar
  become a leading vertical rail. Navigation goes at the top of the rail, and relative
  order is kept across poses.
- **Folds:** where the browser exposes the CSS Viewport Segments API
  (`@media (horizontal-viewport-segments: 2)`, `env(viewport-segment-*)`), the split view
  aligns its divider with the fold and keeps controls out of the folding region. Grids use
  an even column count so they split cleanly. Where the API isn't exposed (check WebKit on
  iPhone Duo), the resize-first container-query layout still holds. There are no fixed
  widths anywhere.

### 4.3 Controls

**Buttons (`components/ui/button.tsx`)**
- **Add `glass` and `glass-prominent` variants.** Keep `default` as the solid prominent
  style for content-layer forms.
- **One prominent action per view,** and a destructive action is never the primary.
- **Every button gets a pressed state.** Async buttons (Unlock, Save, Issue) show an inline
  activity indicator instead of a separate spinner.

**Text fields (`components/ui/input.tsx`)**
- **Behavior:** hint text, inline validation, and even spacing. Password fields are never
  prefilled and use `autocomplete="current-password"` or `"new-password"`.
- **Keyboard attributes:** `inputmode`, `enterkeyhint` and `autocomplete` on every field.
  Codes use `autocomplete="one-time-code"` with a digit-entry view that accepts paste.
- **Keep the focused field visible above the on-screen keyboard** using `visualViewport`.

**Toggles, segmented controls, sliders and steppers**
- **Switches only in setting and list rows; checkboxes for hierarchies.**
- **Segmented controls** (persona, density, list filters) use noun labels, equal segment
  widths, and at most five segments.
- **The password-generator length slider's knob turns to glass while dragged.**
- **TTL inputs get steppers** plus preset selects (pop-up buttons).

### 4.4 Presentation: sheets, popovers, menus, alerts and toasts

**Sheets** (`components/ui/dialog.tsx` and the item, secret, TOTP and share dialogs)
- **Visual:** glass-strong with `--radius-2xl`.
- **Buttons:** Cancel on the leading edge and Done or Save on the trailing edge, never all
  of Cancel, Done and Back together. Every Done has a Cancel or Back alternative.
- **Compact behavior:** an inset bottom sheet with a grabber and medium and large detents.
  It turns more opaque when expanded to full height and supports swipe-to-dismiss, which
  asks for confirmation when there are unsaved edits.
- **One sheet at a time.** A sheet that leads to another sheet closes first.

**Popovers and tooltips**
- **Popovers** are glass, one at a time, and are replaced by sheets at compact widths.
- **Tooltips** explain the action and don't repeat the control's name. They stay brief, and
  the existing `IconTip` hints already mostly comply.

**Menus** (`components/ui/dropdown-menu.tsx`)
- **Visual:** glass.
- **Icons:** for common actions (copy, share, move, rename, delete), either on every item in
  a group or on none.
- **Labels:** title case, with no articles ("View Settings", not "View the Settings"), and
  an ellipsis when more input follows.
- **Structure:** submenus at most one level deep.
- **Context menus** (see §4.6) hide unavailable items; regular menus dim them.

**Alerts and toasts**
- **Alerts are for the critical and actionable only:** irreversible erase, key rotation and
  device revocation. Button titles are verbs ("Erase", "Keep"), never OK for a choice.
- **Toasts (Sonner) become glass capsules** for status and completion ("Copied — clears in
  30 s", "Lease renewed"). They never carry critical information alone.

### 4.5 Search: the command palette

- **The palette is arc's single search location** (Searching: "make your app's content
  searchable through a single location"). It opens from the toolbar search field on
  desktop, the trailing search tab on compact screens, and ⌘K everywhere.
- **Tokens for scope:** Personal, Operator, Engine A, Engine B and Agents. The default is
  the broadest scope, and the current scope is always visible.
- **Suggestions come from navigation and actions.**
- **Privacy:** no persisted search history of vault content. Searches over decrypted item
  titles run in memory on the device and are never stored or sent.

### 4.6 Lists, tables, context menus and swipe actions

- **Rows** (vault items, leases, audit and devices) stay content-layer: no glass. Row height
  and padding increase in line with the Liquid Glass list metrics, section headers use
  title case, and sections take concentric corner radii.
- **Context menus** open on right-click or long-press. Their top actions match the row's
  touch swipe actions (Organization guidance: "match top menu actions to swipe actions").
  Every context action also exists in the main UI. Keyboard shortcuts appear in main
  menus, not in context menus.
- **On desktop, table columns are sortable and resizable.** Descriptive headers, with no
  truncation that hides meaning; expansion tooltips handle truncated values.

### 4.7 Destructive actions, undo and zero-knowledge erase

The HIG says not to raise alerts for common, *undoable* destructive actions, and to offer
undo instead. arc's delete is not undoable: `deleteItem` erases the ciphertext, every
version and attachments server-side immediately (SEC-M3).

- **Keep an explicit confirmation for erase.** It names what's lost; the HIG allows this
  for unexpected, irreversible data loss.
- **Offer Undo toasts only for actions that really are reversible:** moving between
  folders, renaming, unsharing before the recipient syncs, and changing a role back.
- **Soft delete with a grace window is a product decision (D5).** It would enable an Undo
  toast, but it changes the erase guarantee, so it needs a security review first.

### 4.8 Desktop: the Tauri app, the menu bar and windows

- **Real system material.** The desktop window uses Tauri's window effects (macOS vibrancy
  and sidebar material; Mica/Acrylic on Windows) behind the sidebar. On macOS this renders
  the genuine system material rather than the CSS approximation, and the web layer switches
  its sidebar to transparent when a `data-native-material` flag is set.
- **A native menu bar mirrors every toolbar command.** It has standard App, File, Edit,
  View, Window and Help menus with standard shortcuts. Every toolbar item is available as
  a menu command (macOS toolbar guidance), with settings in the App menu.
- **Windows:** any size is supported and the layout adapts. Nothing critical sits at the
  bottom edge (macOS layout guidance).
- **Web views:** support back and forward wherever the app navigates, and don't build
  browser chrome.

### 4.9 Icons, app icon and PWA

- **Keep Lucide,** with a consistent stroke of 1.75–2 px. Use the filled variant (or a
  heavier stroke) for the selected tab, standard icons for standard actions, and no
  bordered circles in toolbars.
- **App icon (PWA and web clip, Tauri):** keep the honeycomb centered on a solid field,
  with no pre-baked gloss, blur or masking, since the system applies those. Test on the
  iOS 27 Home Screen in default, dark, clear and tinted appearances. Update `manifest.json`
  icons and `apple-touch-icon.png`, and add `shortcuts` (Search, Generate password, Lock)
  for Home Screen quick actions.
- **`theme-color`** follows light and dark (`media` attribute) so browser chrome matches the
  content layer. Verify Safari 27's behavior, since tab-bar tinting has changed across
  releases.

### 4.10 Agents: Generative AI guidance for Engine C

The June 2026 Generative AI page maps directly onto the agents and MCP console
(`identities-view.tsx`, `workflows-view.tsx` and the agent task views).

- **Communicate where AI acts.** Agent-initiated rows and intents carry the ember `agent`
  role badge consistently, and every audit entry names the acting principal (the RFC 8693
  `act` claim).
- **Keep people in control.** Push-consent (CIBA) already gates elevated operations. The UI
  shows the exact intent (op, path and argument digest) in the approval sheet, with Approve
  and Deny as equal-weight buttons, never a prominent Approve.
- **Set expectations and make revocation easy.** A task view shows what a delegation allows
  (narrow-only scopes) and "Close task" revokes everything at once. That action is
  prominent and confirmed, since it's destructive for the agent.
- **Refine and revert:** where agents write (for example, `kv.put`), show the version diff
  and a one-click restore of the previous version, which KV v2 history already supports.

## 5. Phased rollout

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **0 · Foundations** | Glass tokens and utilities (§2.2); increased-contrast token overrides; type-scale tokens (§3.2); container-query breakpoints; a `/docs/design/materials` preview page showing every surface in light, dark and increased contrast over the mesh; Playwright visual-regression baselines; performance traces | Tokens merged; the preview page passes contrast checks; traces recorded for both reference devices |
| **1 · Shell** | Floating glass sidebar, glass toolbar groups with scroll edge, glass command palette, menus, popovers, tooltips and toasts; title-case pass on navigation and menus | No solid bars remain over scrolling content; at most four glass layers; keyboard and screen-reader pass of the shell |
| **2 · Responsive** | Compact tab bar ↔ sidebar, minimize on scroll, search tab, bottom sheets with detents, toolbar overflow priorities, safe areas, side rail for wide-and-short viewports, fold-aware split view | Every console task can be completed at 360 px width and in landscape phone; no fixed widths; iOS 27 Safari and Android Chrome pass |
| **3 · Controls** | Button variants, text-field attributes, digit entry, segmented controls, switches and steppers, concentric radii, typography decision (D2) applied | 44 px touch and 28 px pointer targets; the largest iOS text size stacks without truncation |
| **4 · Content polish** | List metrics, section headers, context menus ↔ swipe actions, inspector split view, reversible-action Undo toasts, empty states, writing pass | Design-principles review signed off per view; copy lint for capitalization |
| **5 · Platform** | Tauri native window material and menu bar, PWA icon and shortcuts refresh, `theme-color`, optional Sign in with Apple (D6), optional web push for approvals | Desktop app verified on macOS 27 and Windows 11; icons verified on the iOS 27 Home Screen |

Rollout switch: glass is on by default, and the in-app **Reduce transparency** setting
(`data-glass="off"` on `<html>`) turns every glass surface opaque. That setting is both
the accessibility fallback and the kill switch while the phases land.

**Decisions applied:** the owner asked for implementation to proceed without waiting,
so the recommendations in §8 (D1–D6) are the working defaults and can be revisited in
any phase review.

## 6. Test matrix

| Axis | Values |
| --- | --- |
| Browsers | Safari (iOS 27, macOS 27), Chrome (macOS, Windows, Android), Edge, Firefox |
| Appearance | Light, dark, increased contrast, reduced transparency (plus the in-app fallback), reduced motion |
| Text | 200% browser zoom; iOS text size from smallest to the largest accessibility size |
| Input | Touch, mouse and trackpad, keyboard only, screen reader (VoiceOver on macOS and iOS, NVDA on Windows) |
| Layout | 320, 360, 390, 768, 1024, 1280 and 1920 px widths; landscape phone; iPad split screen; a fold-emulating viewport (Chrome DevTools dual-screen) |
| Locale | English and an RTL pseudo-locale (mirrors layout, icons and order) |
| Performance | Scroll at 60 fps and INP under 200 ms on both reference devices with glass on |

## 7. Risks and guardrails

- **Legibility on glass.** Contrast can't be linted through `backdrop-filter`. The
  mitigation is `glass-strong` for any text-dense surface, screenshot luminance checks, and
  contrast-mode fallbacks.
- **Performance on low-end devices.** The budget in §2.6, the fallback tier, and no glass on
  scrolling rows.
- **Cross-platform expectations.** arc runs on Windows, Android and Linux too. Glass is
  arc's design language on every platform, but the controls follow platform conventions
  where they differ (sheet button placement, shortcuts), per "approach every platform with
  intention" (decision D1).
- **Security perception.** §2.7 keeps sensitive flows opaque and forbids OS-lookalike
  prompts.
- **Scope creep.** The rollout is phased and flagged, and Appendix A marks most
  native-only pages "Not applicable" on purpose.

## 8. Decisions needed

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Glass on every platform, or only on Apple devices? | Every platform. It's arc's design language, with platform conventions for control placement. |
| D2 | Body and UI text: keep IBM Plex Sans, or use `system-ui`? | Try `system-ui` for body and controls behind the flag, and keep Space Grotesk for titles and Geist Mono for secrets. Decide after the Phase 3 review. |
| D3 | Appearance settings | Default to System. Keep a Light/Dark/System override plus a "Reduce transparency" fallback in one menu, and retire the color presets in favor of the single arc accent. |
| D4 | Compact tab sets per persona | Personal: Home, Vault, Security, Devices, Search. Operator: KV, Creds, Leases, Audit, Search. Everything else goes in the sidebar sheet. |
| D5 | Undo for delete (grace window) vs. immediate erase | Keep immediate erase with confirmation. Revisit only with a security review. |
| D6 | Sign in with Apple as an identity provider (through the OIDC plugin) | Optional in Phase 5. Passkeys remain the primary sign-in. |

---

## Appendix A — every HIG page, with disposition

**Adopt** means applying the guidance as written. **Adapt** means the guidance applies, with
a web-specific implementation. **Reference** means reading it, with nothing to build.
**Not applicable** means native-only, hardware or out-of-product.

#### Getting started

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Design principles | Adopt | North star for every phase; the eight principles are the review checklist for each redesigned view (§3). |
| Designing for iOS | Adapt | Mobile web on iPhone: compact layout, floating bottom tab bar, sheets with detents, safe areas (§4.2). |
| Designing for iPadOS | Adapt | Tablet widths: tab bar that converts to a sidebar, touch plus pointer, resizable windows (§4.2). |
| Designing for macOS | Adapt | Desktop browsers and the Tauri app: toolbar conventions, keyboard shortcuts, native window material for desktop (§4.8). |
| Designing for tvOS | Not applicable | No tvOS client. |
| Designing for visionOS | Not applicable | Safari on visionOS renders the web app; no bespoke spatial UI planned. |
| Designing for watchOS | Not applicable | No watch client. |
| Designing for games | Not applicable | Not a game. |
| Designing for iPhone Duo | Adapt | New (Sept 2026). Fold-safe responsive layout: no fixed widths, split view collapses on the outer display, side-placed bars on wide-and-short viewports, CSS viewport segments where available (§4.2). |

#### Foundations

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Accessibility | Adopt | WCAG-aligned contrast (4.5:1 up to 17 pt, 3:1 at 18 pt or bold), 44 px touch targets, full keyboard use, labelled icon buttons, reduced transparency, contrast and motion (§2.4). |
| App icons | Adapt | PWA and web-clip icons and the Tauri desktop icon: simplified, centered honeycomb on a solid field; test on the iOS 27 Home Screen and in dark and tinted modes (§4.9). |
| Branding | Adopt | Updated Sept 2026. Accent sparingly (primary action, selection, status); brand color and mesh live in the content layer under glass; no logo repetition (§3.1). |
| Color | Adopt | Liquid Glass color rules: glass has no inherent color, tint only the primary action's background, monochrome labels on glass; light, dark and increased-contrast variants for every token (§2.3). |
| Dark Mode | Adopt | Default to the system appearance; decide whether to keep the in-app override and color presets (decision D3). |
| Icons | Adapt | Keep Lucide (ISC); standard icons for standard actions, filled variant for the selected tab, no bordered toolbar icons, accessible names everywhere. |
| Images | Reference | Few raster images; keep @2x assets and sRGB or Display P3 profiles for marketing art. |
| Immersive experiences | Not applicable | visionOS immersive spaces. |
| Inclusion | Adopt | Folds into the writing pass: plain, inclusive, gender-neutral copy; no culture-specific color meanings. |
| Layout | Adopt | Updated Sept 2026. Size classes become container queries; controls separated from content by glass plus a scroll-edge effect; backgrounds extend beneath the sidebar; safe areas (§4.1–4.2). |
| Materials | Adopt | The core of this plan: Liquid Glass for the functional layer only, regular vs clear variants, a dimming layer over bright content; standard materials in the content layer (§2). |
| Motion | Adopt | Purposeful and optional (reduced motion); glass morphs for menus and popovers; no motion on high-frequency interactions (§2.5). |
| Privacy | Adopt | Already core to arc. Permission copy for the QR camera, no search history of vault content, passkeys over passwords. |
| Right to left | Adopt | CSS logical properties throughout; mirror directional icons; keep the sidebar on the leading edge. |
| SF Symbols | Reference | Not shipped. The SF Symbols terms restrict use (never in logos); arc keeps Lucide and follows the same conventions. |
| Spatial layout | Not applicable | visionOS. |
| Typography | Adopt | A type scale mapped to the HIG text styles (Body 17/22 on iOS, 13/16 on macOS), rem-based so browser text size scales, a Dynamic Type hook on iOS Safari, no light weights, 11 px minimum (decision D2). |
| Writing | Adopt | One capitalization rule set (title case for menus, buttons, section headers, tab and view titles; sentence case for descriptions), clear errors, next steps on every empty state. |

#### Patterns

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Charting data | Adapt | Security score, lease timelines and audit activity: common chart types, text summaries, accessible data tables. |
| Collaboration and sharing | Adapt | Team vault and share dialogs: Share action in the toolbar; short permission summaries. |
| Drag and drop | Adapt | Vault import files, attachments, reordering folders; always offer a non-drag alternative. |
| Entering data | Adopt | Secure fields, never prefilled; offer choices over typing; validate inline; paste-friendly (recovery keys, TOTP secrets). |
| Feedback | Adopt | Status inline (lease state, sync), alerts only when critical, confirm completion of significant tasks. |
| File management | Adapt | Export and import of encrypted vault files: clear save destinations, no custom file browser. |
| Going full screen | Reference | Possible later for the architecture diagram viewer. |
| Launching | Adopt | No splash screen; restore the last section and persona; show the unlock screen instantly. |
| Live-viewing apps | Not applicable | No live media. |
| Loading | Adopt | Show something at once (skeletons that match the final layout), let people keep working, determinate progress for long crypto jobs. |
| Managing accounts | Adopt | Passkeys first (already), delay sign-in (preview mode), a clear account-deletion flow (backlog), no app-specific biometric toggle. |
| Managing notifications | Adapt | Only if web push is added for approval requests (CIBA push-consent); urgency must be truthful. |
| Modality | Adopt | Sheets only for scoped tasks; one at a time; confirm before discarding edits; obvious dismissal. |
| Multitasking | Adapt | Finish user-started work in the background (sync, re-encryption); pause timers that need attention. |
| Offering help | Adopt | Tooltips describe the action and don't repeat the control's name; contextual tips instead of a tour. |
| Onboarding | Adopt | Teach by doing: contextual tips across the console; keep enrolment short; no licensing text. |
| Playing audio | Not applicable | No audio. |
| Playing haptics | Not applicable | The web has no haptics on iOS. |
| Playing video | Not applicable | No video. |
| Printing | Adapt | The recovery-key print sheet already exists; make printing discoverable only where it's possible. |
| Ratings and reviews | Not applicable | No store listing. |
| Searching | Adopt | The command palette is the single search location: visible scope, suggestions, and no persisted history of vault content (§4.5). |
| Settings | Adopt | Fewer settings; respect system settings (appearance, motion, contrast); task options inline. |
| Undo and redo | Adapt | Undo toasts where an action is reversible; keep an explicit confirmation where the server erases ciphertext immediately (§4.7). |
| Workouts | Not applicable | Not a fitness app. |

#### Components · Content

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Charts | Adapt | See Charting data. |
| Image views | Reference | Minimal imagery. |
| Text views | Adopt | Secure-note editor: comfortable measure, selectable text, system text behavior. |
| Web views | Adapt | The Tauri desktop app is a web view: support back and forward where there's navigation; don't build browser chrome. |

#### Components · Layout and organization

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Boxes | Adapt | Grouped sections and cards in the content layer (standard materials, not glass). |
| Collections | Adapt | Home and security grids; even column counts, which also split cleanly on fold. |
| Column views | Not applicable | macOS Finder-style browser; not needed. |
| Disclosure controls | Adopt | Progressive disclosure in item details and advanced policy options. |
| Labels | Adopt | Selectable, copyable static text; secondary and tertiary label colors for hierarchy. |
| Lists and tables | Adopt | Vault items, leases and audit rows: larger row height, title-case section headers, sortable columns on desktop (§4.6). |
| Lockups | Not applicable | tvOS. |
| Outline views | Adapt | Folder tree and KV path tree. |
| Split views | Adopt | List plus detail (vault item inspector) at regular widths, collapsing to one pane at compact widths or on fold (§4.1). |
| Tab views | Adapt | In-page tabs (settings panes, item history). |

#### Components · Menus and actions

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Activity views | Adapt | Web Share only for non-secret links (such as docs); never for secret material. |
| Buttons | Adopt | Add glass and prominent-glass variants; one primary action per view; destructive actions never primary; in-button activity indicator (§4.3). |
| Context menus | Adopt | Right-click or long-press on rows, with the same top actions as the row's swipe actions; hide unavailable items; no shortcuts shown (§4.6). |
| Dock menus | Not applicable | Only relevant if the desktop app adds dock actions later. |
| Edit menus | Reference | Native browser edit menus apply; don't override Cut, Copy, Paste. |
| Home Screen quick actions | Adapt | PWA manifest shortcuts (Search, Generate password, Lock). |
| Menus | Adopt | Updated June 2026. Glass menus, icons for common actions applied uniformly per group, title-case labels, ellipsis when more input follows (§4.4). |
| Ornaments | Not applicable | visionOS. |
| Pop-up buttons | Adopt | Selects for mutually exclusive options (vault picker, TTL presets). |
| Pull-down buttons | Adopt | A More menu for secondary actions; destructive items confirmed. |
| The menu bar | Adapt | Tauri desktop: a native menu bar mirroring every toolbar action with standard shortcuts (§4.8). |
| Toolbars | Adopt | Glass toolbar with at most three groups, one prominent trailing action, icon-only items with accessible names, priority-based overflow (iOS 27 visibility priority), minimize on scroll on compact screens (§4.1). |

#### Components · Navigation and search

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Path controls | Adapt | KV and PKI path breadcrumbs. |
| Search fields | Adopt | Updated June 2026. Search in the toolbar (trailing) on desktop and as a trailing search tab on compact screens; tokens for scopes (§4.5). |
| Sidebars | Adopt | Updated June 2026. A floating glass sidebar with content extending beneath it, at most two levels, title-case group labels, hideable, icons in the accent color (§4.1). |
| Tab bars | Adopt | Updated June 2026. At compact widths, a floating glass tab bar of five or fewer tabs, with a button to convert it to the sidebar; search as the trailing tab; never hide or disable tabs (§4.2). |
| Token fields | Adapt | Search scopes, share recipients, policy capability chips. |

#### Components · Presentation

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Action sheets | Adapt | Confirmations anchored to the triggering control (a popover-style confirm), not a bottom sheet on desktop. |
| Alerts | Adopt | Only for critical, actionable information (irreversible erase, key rotation); verb-based button titles, never OK for choices. |
| Page controls | Not applicable | No paged carousels. |
| Panels | Adapt | An inspector panel for item details and audit entries at wide widths. |
| Popovers | Adopt | Glass popovers for small tasks; one at a time; not at compact widths (use a sheet there). |
| Scroll views | Adopt | Updated June 2026. A scroll-edge effect under the floating toolbar instead of solid bars; one per pane; no nested scrolling on the same axis (§2.2). |
| Sheets | Adopt | Updated March 2026. Glass sheets; Cancel on the leading edge, Done on the trailing edge; on mobile, an inset half-sheet with a grabber that becomes more opaque at full height; one sheet at a time (§4.4). |
| Windows | Adapt | The viewport is the window: support any size; desktop app windows get a native material (§4.8). |

#### Components · Selection and input

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Color wells | Not applicable | No color picking (decision D3 removes the presets). |
| Combo boxes | Adapt | Autocomplete fields (vault or path pickers). |
| Digit entry views | Adopt | TOTP, device-approval and recovery codes: segmented digit entry with paste support and one-time-code autocomplete. |
| Image wells | Not applicable | — |
| Pickers | Adapt | Date and time for expiries and TTLs; native inputs where they work. |
| Segmented controls | Adopt | Persona switch (Personal/Operator), density, list filters: nouns, same-size segments, at most five. |
| Sliders | Adapt | Password generator length; the knob turns to glass while dragged. |
| Steppers | Adapt | TTL and count inputs. |
| Text fields | Adopt | Hints, secure entry, correct inputmode, autocomplete and enterkeyhint, inline validation, even spacing (§4.3). |
| Toggles | Adopt | Switches only in list or setting rows; checkboxes for hierarchies; the knob turns to glass while dragged. |
| Virtual keyboards | Adopt | inputmode, enterkeyhint and autocomplete for every field; keep the focused field visible above the keyboard (visualViewport). |

#### Components · Status

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Activity rings | Not applicable | Fitness. |
| Gauges | Adapt | The security score ring and lease remaining-time ring. |
| Progress indicators | Adopt | Determinate where possible (import, re-key, export); consistent placement; cancellable. |
| Rating indicators | Not applicable | — |

#### Components · System experiences

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| App Shortcuts | Not applicable | Native only. |
| Complications | Not applicable | watchOS. |
| Controls | Not applicable | Control Center; native only. |
| Live Activities | Not applicable | Native only. |
| Notifications | Adapt | Only if web push is adopted for approvals; truthful urgency, no marketing. |
| Snippets | Not applicable | New (June 2026); App Intents results, native only. |
| Status bars | Adapt | theme-color and the iOS web-app status bar style; content extends beneath with safe-area insets. |
| Top Shelf | Not applicable | tvOS. |
| Watch faces | Not applicable | watchOS. |
| Widgets | Not applicable | Native only. |

#### Inputs

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| Action button | Not applicable | Hardware. |
| Apple Pencil and Scribble | Reference | Scribble works in standard web text fields automatically; don't block it with custom inputs. |
| Camera Control | Not applicable | Hardware. |
| Digital Crown | Not applicable | Hardware. |
| Eyes | Not applicable | visionOS; standard hover states make the web app eye-friendly. |
| Focus and selection | Adopt | Visible :focus-visible rings on fields, highlight in lists, no programmatic focus jumps. |
| Game controls | Not applicable | — |
| Gestures | Adopt | Standard touch gestures: swipe actions on rows, edge swipe to reveal the sidebar, swipe-down to dismiss sheets; always with button alternatives. |
| Gyroscope and accelerometer | Not applicable | — |
| Keyboards | Adopt | Full keyboard access, standard shortcuts untouched, custom shortcuts only for frequent commands (⌘K), shortcuts shown in menus. |
| Nearby interactions | Not applicable | — |
| Pointing devices | Adopt | Hover states shaped like the control, comfortable hit regions, pointer reveals minimized controls. |
| Remotes | Not applicable | tvOS. |

#### Technologies

| Page | Disposition | What it means for arc |
| --- | --- | --- |
| AirPlay | Not applicable | — |
| Always On | Not applicable | — |
| App Clips | Not applicable | — |
| Apple In-App Purchase | Not applicable | No purchases. |
| Apple Pay | Not applicable | No payments (revisit only for a hosted billing tier). |
| Augmented reality | Not applicable | — |
| CareKit | Not applicable | — |
| CarPlay | Not applicable | — |
| Game Center | Not applicable | — |
| Generative AI | Adopt | Updated June 2026. The Engine C agents and MCP console: say where AI acts, get consent before irreversible operations (push-consent already exists), make results revertible, show agent activity transparently (§4.10). |
| HealthKit | Not applicable | — |
| HomeKit | Not applicable | — |
| iCloud | Not applicable | arc is its own sync. Note that iCloud Keychain passkeys sync affects passkey copy. |
| ID Verifier | Not applicable | — |
| iMessage apps and stickers | Not applicable | — |
| Live Photos | Not applicable | — |
| Mac Catalyst | Not applicable | The desktop app is Tauri. |
| Machine learning | Reference | On-device analysis (weak-password audit) already runs locally; follow its transparency guidance. |
| Maps | Not applicable | — |
| NFC | Not applicable | — |
| Photo editing | Not applicable | — |
| ResearchKit | Not applicable | — |
| SharePlay | Not applicable | — |
| ShazamKit | Not applicable | — |
| Sign in with Apple | Adapt | Possible identity provider through the existing OIDC auth plugin; follow the web button guidelines if added (decision D6). |
| Siri | Not applicable | Native only. |
| Tap to Pay on iPhone | Not applicable | — |
| VoiceOver | Adopt | Every icon-only control labelled; live regions for status (lease expiry, sync); tested with VoiceOver and NVDA. |
| Wallet | Not applicable | — |

**Totals:** 158 guideline pages. 53 Adopt, 36 Adapt, 7 Reference and 62 Not applicable.

## Appendix B — Sources

- Apple Human Interface Guidelines,
  <https://developer.apple.com/design/human-interface-guidelines>. All pages were read from
  Apple's published documentation data on 28 September 2026. The most recent change-log
  entry was 17 September 2026 (Apple In-App Purchase).
- Apple, *Adopting Liquid Glass*,
  <https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass>.
- Xcode 27 agent skills (`swiftui-whats-new-27` toolbar reference), for iOS 27 toolbar
  overflow and visibility-priority behavior. Apple-authored; read only, not redistributed.
- arc design system tokens and components in `apps/arc-vault-web/src/app/globals.css`,
  `components/arc/*`, `components/brand/*` and `components/vault/console-shell.tsx`.
