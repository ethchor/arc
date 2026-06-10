# arc — Trademark Policy

**Last updated:** 2026-06-10

## TL;DR

arc is open source under the [Apache License 2.0](LICENSE). Anyone may fork the
code, build derivatives, and ship them commercially. But the **brand "arc"**
(name, logo, mark) belongs to the project maintainers and is **not** part of
the Apache 2.0 grant. This policy explains what's allowed without permission,
what needs permission, and how to ask.

## What Apache 2.0 covers (and doesn't)

[Apache 2.0 §6](LICENSE) explicitly excludes "trademarks, service marks, or
product names" from the license grant. So:

| Thing | Covered by Apache 2.0 | Covered by this Trademark Policy |
| ----- | --------------------- | --------------------------------- |
| The source code & built artifacts | ✅ Yes — use, modify, redistribute, sell | ❌ Not the concern of this doc |
| The patent grant from contributors | ✅ Yes — §3 | ❌ Not the concern of this doc |
| The name "arc" | ❌ No | ✅ This doc |
| The arc word mark and logo | ❌ No | ✅ This doc |
| Naming a fork "arc-fork" or "arc-by-acme" | ❌ No | ✅ This doc — see "Allowed without permission" |
| Calling a hosted service "arc Cloud" | ❌ No | ✅ This doc — needs permission |

## The brand assets

- **Word mark:** "arc" (lowercase) and "arc Vault"
- **Logo:** the `arc/` glyph wherever it appears in the repo, on the docs site, and on
  arc-branded surfaces
- **Domains:** `arc.dev` and any subdomain, when claimed

The maintainers may register one or more of these as formal trademarks in
relevant jurisdictions; even unregistered, common-law trademark rights apply.

## Allowed without permission

You may use the name "arc" without asking when:

1. **Truthful descriptions of your fork or derivative.** "Fork of arc",
   "compatible with arc", "based on arc", "X for arc", "X integrates with arc"
   — these are nominative use and welcome.
2. **Bug reports, talks, tutorials, blog posts, comparisons.** Mentioning arc
   editorially is free speech and you don't need our permission.
3. **Internal use.** Running an arc-derived build inside your company under any
   internal name you want — this policy is about *public-facing* product
   identity, not what you call it on your own servers.
4. **Academic / educational use** of the name in a curriculum, paper, or
   thesis.

## Needs prior written permission

You may **not** use the name "arc" or the arc logo without explicit written
permission from the maintainers when doing any of:

1. **Distributing a binary, package, image, or service called "arc"** (or a
   confusingly similar name like "Arc", "Ark", "ARC Vault", "arc-cloud") that
   isn't an official arc release.
2. **Offering a hosted or managed service named "arc"** — e.g. "arc Cloud",
   "arc Hosted", "arc-as-a-Service", "Acme's arc".
3. **Selling merchandise, swag, or other physical goods** bearing the name or
   logo.
4. **Using the arc logo** in a way that implies endorsement, certification, or
   official affiliation.
5. **Domain names** that include "arc" in a way likely to be confused with the
   project (e.g. `arcvault.com`, `arc-secrets.io`, `getarc.dev`).

The maintainers reserve the right to grant or refuse any of these on a
case-by-case basis. We don't intend to be unreasonable — we will say yes to
most reasonable uses, particularly community-driven ones — but the default
is "ask first."

## Forks and derivatives

If you fork arc and ship the result publicly, you have two clean options:

1. **Keep the upstream branding** if your fork is a temporary patch or a
   minor variant that tracks upstream. Make it obvious in your README that
   it's an unofficial fork (e.g. "arc-fork by Acme — patches for our internal
   deployment"). This is allowed without asking.
2. **Rebrand cleanly** if your fork diverges substantially or you intend to
   commercialize it as a distinct product. Pick a new name, new logo, new
   project identity. The Apache 2.0 license obligates you to preserve the
   `LICENSE` and `NOTICE` files (the attribution requirement); you don't have
   to drop the name *credit* from those files, but you do have to stop using
   the arc *brand* as your product identity.

The standard inflection point: are users going to install your project
expecting it to be official arc? If yes, you need permission or a rename.
If no, truthful "based on arc" attribution is fine.

## Hosted services — the AWS-style scenario

This policy is the brand-side answer to the question "what stops a hyperscaler
from reselling arc as `<provider> Vault`?" The license can't (Apache 2.0
permits commercial use); trademark law can.

A hyperscaler running arc-derived code internally and exposing it as a service
**must not call it "arc"** — they need to call it something else (e.g. "Acme
Secrets Manager, based on arc"). This is enforceable under trademark law
independently of the source license.

This is the same model HashiCorp ran with Vault and Elastic with Elasticsearch
before they switched licenses: Apache 2.0 + trademark protection. The brand
boundary holds the line even when the code boundary doesn't.

## Logo guidance

When using the arc logo under permitted nominative use (e.g. "compatible with
arc" badging on your project page):

- Use the official logo from `docs/brand/` (when it lands) — don't recreate
  or modify it.
- Don't combine it with other logos in a way that implies a partnership.
- Don't change the colors, proportions, or typography of the wordmark.
- Don't use it as the primary identifier for a non-arc product.

## Reporting confusing use

If you see someone using "arc" in a way that's confusing or implies
affiliation/endorsement that doesn't exist (e.g. a phishing site claiming to
be "arc Cloud", a SaaS called "arcvault.io" we don't run), please file an
issue or email the maintainers. We'll evaluate and pursue takedown where
warranted.

## Asking permission

Open a GitHub issue tagged `trademark` with:

1. What you want to do (product name, service name, swag, logo use).
2. The audience and rough scale (community demo vs. commercial service).
3. How users will reach the original arc project if they want it (we ask that
   you link upstream so users aren't confused).

Maintainers will respond. For commercial / corporate requests at scale,
email the maintainers directly (contact in `CONTRIBUTING.md`).

## Honest scope

- This is a **policy**, not formal legal advice. If you're commercializing
  something arc-adjacent at scale, have your own attorney review your plans.
- The maintainers retain final say on what is and isn't permitted; this
  document codifies the intent but doesn't waive any rights.
- Policy may evolve. Material changes will be announced in releases / CHANGELOG.

---

**Acknowledgements.** Inspired by the trademark policies of CNCF projects,
HashiCorp pre-BSL, and the Linux Foundation guidance — adapted for arc's
posture as a permissively-licensed but brand-protected project.
