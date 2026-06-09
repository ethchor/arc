# arc-plugin-sign

Operator-facing CLI for the arc plugin-manifest gate (ADR-005 Phase 5b).

Plugins shipped against arc-server's `mountRemoteSecretsPlugin` / `mountWasmSecretsPlugin`
ride a **signed manifest** that pins the artifact's SHA-256 + the publisher's identity +
the **capabilities the plugin is allowed to exercise** at runtime. This CLI is the build-
time side of that contract:

- generate a publisher Ed25519 keypair
- sign a manifest pinning an artifact + a verb set from the arc-grants vocabulary
- verify a manifest locally before staging it for release

It uses the same primitives arc-server's `PluginManifestService` uses
(`signPluginManifest` / `verifyPluginManifest` from `@arc/crypto`), so a manifest that
verifies here is byte-identical to what the server will accept.

## Install (workspace)

```sh
pnpm --filter @arc/plugin-sign build
# the bin is now at tools/arc-plugin-sign/dist/bin.js — run via `node`, or pnpm exec.
```

## Operator workflow — one-time keygen

```sh
# Generate a publisher keypair. Keeps the priv mode 0600; emits the pub on stdout.
arc-plugin-sign keygen --out-priv ./publisher.key
# → prints <pub-b64u> to stdout

# Stash the priv as a CI secret (e.g. ARC_PUBLISHER_PRIV) — never commit it.
# Publish the pub somewhere operators can pin it on the server:
#
#   ARC_PLUGIN_TRUST_ANCHORS=publisher:arc-core=<pub-b64u>
#
# That's the single trust input the gate consults.

# In a release workflow where only the priv is in secrets, re-derive the matching pub:
arc-plugin-sign pubkey --priv env:ARC_PUBLISHER_PRIV
# → prints the same <pub-b64u> as `keygen` did originally
```

## Per-release — sign a manifest

```sh
# 1. Build the plugin artifact (a self-contained bin.cjs for OOP, or a .wasm).
pnpm --filter @arc/plugin-aws build

# 2. Sign a manifest pinning the artifact + the verb set the plugin actually needs.
#    `creds/<role>` issue ⇒ read; lease renew ⇒ update; lease revoke ⇒ delete.
arc-plugin-sign sign \
  --artifact plugins/cloud/arc-plugin-aws/dist/bin.cjs \
  --priv env:ARC_PUBLISHER_PRIV \
  --publisher publisher:arc-core \
  --name arc-plugin-aws \
  --version 0.1.0 \
  --kind process \
  --capabilities read,update,delete \
  --out plugins/cloud/arc-plugin-aws/dist/manifest.json
```

Ship `bin.cjs` + `manifest.json` together. The operator mounts via
`PluginsService.mountRemoteSecretsPlugin(spec, mountPath, config, manifest)` (or
the equivalent admin API once it lands); the server re-hashes the artifact, verifies the
signature against the trust anchor, and enforces the declared capability set on every
dispatch.

## Verify locally (recommended pre-release check)

```sh
arc-plugin-sign verify \
  --artifact plugins/cloud/arc-plugin-aws/dist/bin.cjs \
  --manifest plugins/cloud/arc-plugin-aws/dist/manifest.json \
  --pub ./publisher.pub
```

Exit codes: `0` ok · `1` usage/IO error · `2` verification refused (reason on stderr —
matches the server's `PluginManifestService.verify` reason strings).

## Capability vocabulary

| verb     | meaning when arc-server dispatches against the plugin's mount             |
| -------- | -------------------------------------------------------------------------- |
| `create` | KV PUT against a fresh key (alongside `update`)                            |
| `read`   | `<mount>/creds/<role>` issue · KV read · PKI read · transit read           |
| `update` | KV PUT against an existing key · transit/PKI write · lease renew           |
| `delete` | KV delete · lease revoke                                                   |
| `list`   | KV list · PKI cert list                                                    |
| `sudo`   | short-circuits the gate — every verb allowed on this mount                 |

Omitting `--capabilities` entirely opts the mount **out of the runtime gate** (same as
having no manifest); pass an explicit list to enforce. An empty `--capabilities ""`
declares the strictest zero-trust posture and refuses every gated request — useful for
testing that the gate is wired.

## Release pipeline shape

```yaml
# .github/workflows/release-plugin-<name>.yml (sketch)
on:
  push:
    tags: [plugin-<name>-v*]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @arc/plugin-<name> build
      - run: pnpm --filter @arc/plugin-sign build
      - name: Sign manifest
        env:
          ARC_PUBLISHER_PRIV: ${{ secrets.ARC_PUBLISHER_PRIV }}
        run: |
          node tools/arc-plugin-sign/dist/bin.js sign \
            --artifact plugins/.../<name>/dist/bin.cjs \
            --priv env:ARC_PUBLISHER_PRIV \
            --publisher publisher:arc-core \
            --name arc-plugin-<name> \
            --version ${GITHUB_REF_NAME#plugin-<name>-v} \
            --kind process \
            --capabilities read,update,delete \
            --out plugins/.../<name>/dist/manifest.json
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            plugins/.../<name>/dist/bin.cjs
            plugins/.../<name>/dist/manifest.json
```

## Complementary layer — cosign keyless (sigstore)

The Ed25519 manifest signing above is **arc-server's** trust input — it's what
`PluginManifestService` checks at runtime. The release workflow
(`.github/workflows/release-plugin-aws.yml`) adds a **second layer** on top:
`cosign sign-blob` against each release artifact, with the cosign cert issued by
Fulcio bound to the GitHub Actions OIDC identity for this workflow file, and the
signature recorded in the Rekor public transparency log.

Operators (or anyone on the internet) verify a release without any pre-shared secret:

```sh
# Install cosign once: brew install cosign / apt-get install cosign / etc.
for f in bin.cjs manifest.json SHA256SUMS; do
  cosign verify-blob \
    --bundle "$f.bundle" \
    --certificate-identity-regexp '^https://github.com/ethchor/arc/.github/workflows/release-plugin-aws.yml@.*' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$f"
done
```

What this proves on top of the manifest signature:

- **Provenance** — the artifact was built by *this exact workflow file* at *this exact
  commit*, not just "by someone who controls the publisher's Ed25519 priv."
- **Transparency** — the signature is in Rekor. Years from now, anyone can audit that the
  release wasn't quietly re-signed by a key compromise.
- **No long-lived keys** — the cosign cert is short-lived (~10 minutes), issued at
  release time, and the binding is to the OIDC identity rather than a secret operators
  have to rotate.

The two layers stack: manifest signing protects against artifact substitution by anyone
who doesn't have the publisher key; cosign protects against silent retroactive
re-signing (or against the publisher key being compromised — the cosign log shows the
original signing event).

`arc-plugin-sign` itself does **not** invoke cosign — operators install cosign
separately. The verification is documented here so the release notes can point at it.
