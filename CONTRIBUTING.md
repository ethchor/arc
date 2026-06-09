# Contributing to arc

Thanks for considering a contribution to **arc**. This doc covers the practical bits;
everything technical (layout, dependency rules, naming, test posture) lives in
[`docs/CLAUDE.md`](docs/CLAUDE.md).

## Before your first PR — read the CLA

By opening a pull request you agree to the [Contributor License Agreement](CLA.md). The
CLA grants the project maintainers a perpetual, irrevocable license to your contribution
**and explicitly allows future relicensing** of your contribution (e.g. to a
source-available license like FSL or BSL if the project ever needs to defend against
unrestricted hyperscaler resale). You retain copyright in your own work; you're granting a
license, not assigning ownership.

If you're contributing on behalf of your employer, please reach out to the maintainers
before your first PR so we can execute a Corporate CLA.

**Signal agreement** on each commit:

```sh
git commit -s -m "fix: …"      # adds Signed-off-by: Your Name <your@email>
```

When a CLA bot is wired into CI it'll prompt you on your first PR; for now the
`Signed-off-by` trailer + your PR submission constitute your agreement to the CLA.

## License

The project is licensed under [Apache License 2.0](LICENSE). Your contributions land under
the same license (and, per the CLA, are eligible for future relicensing by the
maintainers). Third-party attribution lives in [`NOTICE`](NOTICE) — please update it if
you add a new dependency that requires attribution.

## Branch + PR workflow

- One PR per area of work. Use the category-prefixed branch names from
  [`docs/CLAUDE.md`](docs/CLAUDE.md) — `feat/`, `fix/`, `ops/`, `plugins/`,
  `architecture/`, `chore/`, `design/`.
- Open PRs against `develop`, not `main`. Merges to `main` happen on release.
- CI must be green. The pre-push git hook (`pnpm run hooks:install`) runs the same
  `pnpm build && pnpm typecheck && pnpm test` that CI runs — fail fast locally.
- Commits should be **GPG-signed** so GitHub shows "Verified." If you don't have a signing
  key set up yet, [GitHub's docs](https://docs.github.com/en/authentication/managing-commit-signature-verification)
  walk through it.

## Code quality

- TypeScript everywhere except where Rust is the right call (`crates/`).
- Tests for every behavior change. Match the existing test style in the package you're
  touching.
- No new dependencies without a one-line rationale in the PR description. Crypto / network
  / process-spawn dependencies require a higher bar — flag them in a code-review comment.
- Don't copy from Vault (BSL) or vendor Vaultwarden (AGPL). See `docs/CLAUDE.md` for the
  full licensing rules.

## Security

If you find a vulnerability, **do not** open a public issue. Email the maintainers
privately (see the contact in [`docs/CLAUDE.md`](docs/CLAUDE.md) — TBD: dedicated
security@arc inbox). Coordinated disclosure preferred.

## Questions

Open an issue with the `question` label, or comment on a relevant existing issue/PR.
