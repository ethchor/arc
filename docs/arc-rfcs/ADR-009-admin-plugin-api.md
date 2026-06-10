# ADR-009 — Admin HTTP API for runtime plugin mount/unmount

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** ethchor
- **Depends on:** ADR-005 (agentic identity / Engine C), PR #34 (manifest gate), PR #36
  (boot-time auto-mount), PR #40 (cosign keyless)

## Context

PR #36 landed the `ARC_PLUGIN_MOUNTS` boot-time auto-mount path: operators write a
comma-separated env entry, restart arc-server, and the boot lifecycle hook mounts each
plugin through the verified-manifest gate. That closed the "how does a plugin actually get
loaded" gap for the *initial* state, but the body of #36 explicitly deferred the live
admin endpoint:

> **No admin HTTP endpoint** — runtime mount/unmount stay programmatic-from-config; an
> admin API needs its own ADR (auth boundary + audit shape).

Three real-world flows make that deferred half visible enough to finish:

1. **Add a plugin to a running server** without dropping every active lease (which a
   restart would do for OOP plugins that own SDK clients with in-flight refreshes).
2. **Disable a misbehaving plugin** instantly — pulling its env entry then bouncing is
   minutes of downtime in front of an incident.
3. **Operate K8s arc-server pods** behind a load balancer where rolling all replicas to
   pick up an env change is a real operational event, not free.

The mechanics underneath (`PluginsService.mountRemoteSecretsPlugin` /
`PluginsService.unmount`) are already production-grade — they're what the boot loop and
the in-process tests both drive. This ADR is about wrapping them in HTTP under an auth
boundary that doesn't widen the attack surface.

## Decision

### 1. Surface — `POST /v1/sys/plugins/mounts` + `DELETE /v1/sys/plugins/mounts/:mountPath`

Two endpoints, both on the existing `/v1/*` engine surface so the existing
`JwtAuthGuard` + `CapabilityGuard` chain protects them with no new auth code path.

**`POST /v1/sys/plugins/mounts`** — mount one plugin. Body:

```json
{
  "mountPath": "aws/",
  "binPath": "/opt/arc/plugins/aws/bin.cjs",
  "manifestPath": "/opt/arc/plugins/aws/manifest.json",
  "configPath": "/opt/arc/plugins/aws/config.json"
}
```

`mountPath` and `binPath` are required. `manifestPath` is optional but **strongly
recommended** — when omitted, the request goes through the same "no manifest" branch the
gate already supports and the operator forfeits the runtime capability check. `configPath`
is optional and threaded into the plugin's `configure()` exactly like the env path does.

Response on success is the same `MountedPlugin` shape `mountRemoteSecretsPlugin` returns
(204 would lose the plugin's resolved name + declared caps, which the admin needs in the
*same* round-trip to write the matching grants policy):

```json
{
  "data": {
    "name": "arc-plugin-aws",
    "version": "0.1.0",
    "mountPath": "aws/",
    "declaredCapabilities": ["delete", "read"]
  }
}
```

**`DELETE /v1/sys/plugins/mounts/<mountPath>`** — unmount. The path segment is URL-encoded
so `aws/` is sent as `aws%2F`. 204 on success.

The path-encoded form (over a body) matches Vault's `/v1/sys/mounts/:path` convention and
makes the request idempotent + cacheable-by-URL for tooling.

### 2. Auth — sudo on `sys/plugins/`, no new mechanism

The existing `CapabilityGuard` strips `/v1/` and matches the policy store by path prefix.
Routing the new endpoints under `sys/plugins/` makes the policy:

```json
{
  "name": "plugin-admin",
  "scopes": [{ "pathPrefix": "sys/plugins/", "capabilities": ["sudo"] }]
}
```

Bootstrap subjects in `ARC_ROOT_USERS` already get `sudo` on `*` via the seeded `root`
policy, so the first admin can mount immediately without a chicken-and-egg setup step.
Operators delegating runtime plugin management to a non-root operator attach the
`plugin-admin` policy explicitly — same path as every other delegated capability.

Why **`sudo`** and not separate `create`/`delete` capabilities: mounting a plugin gives
the resulting mount path the verb set declared by its manifest, which can include `sudo`
itself. Letting `create` on `sys/plugins/` produce a mount that exposes `sudo` on a child
mount-path is a privilege-escalation primitive ([CWE-269]). Requiring `sudo` upfront makes
the dangerous step explicit and unambiguous.

[CWE-269]: https://cwe.mitre.org/data/definitions/269.html

### 3. Validation — happens at the existing layers, surfaced verbatim

The controller validates the DTO shape (`class-validator`) and rejects malformed paths
(`mountPath` must end in `/`, `binPath` must be absolute). Everything else is the
manifest gate's job and the gate's structured `BadRequestException` body
(`reason: "artifact_hash_mismatch"`, `reason: "untrusted_publisher"`, etc.) bubbles
up unchanged. Operators see the same refusal strings on the API that they see in the
boot log when `ARC_PLUGIN_MOUNTS` refuses an entry — one vocabulary, two surfaces.

Conflict on duplicate mount path or duplicate plugin name returns 409 (the underlying
`PluginsService` already throws `BadRequestException` with `plugin already registered` /
`mount path conflict` reasons; the controller maps those to 409 with the original reason
intact).

### 4. Audit — request log is the audit, structured at the source

`pino-http` already records every authenticated request with method, URL, `req.user.userId`,
response status, and the structured error reason for refusals. That's the same record arc
treats as authoritative for every other `/v1/*` admin operation today (policy upsert,
member add, etc.) — there is no separate `@arc/audit` device routing yet on the engines
surface, and inventing one just for these two endpoints would be the wrong layer.

`PluginsService.mountRemoteSecretsPlugin` and `unmount` both log structured `LOG`
entries (`mounted plugin <name>@<version> at <path>`, `unmounted plugin <name> from
<path>`) — those are the audit-grade events. The controller doesn't double-log.

When a dedicated audit-device routing lands on `/v1/*` (out of scope here), these two
endpoints inherit it for free along with every other engines route.

### 5. Lifecycle — admin mounts are NOT persisted across restarts

A plugin mounted via this API survives **only until** the next arc-server restart. To
keep it across restarts the operator adds it to `ARC_PLUGIN_MOUNTS` as well. The API
response includes the `ARC_PLUGIN_MOUNTS` env-var snippet for the just-mounted plugin so
the admin can copy-paste it into the deployment's env without recomputing the URL
shape:

```json
{
  "data": {
    "name": "arc-plugin-aws", "version": "0.1.0", "mountPath": "aws/",
    "declaredCapabilities": ["delete", "read"],
    "envSnippet": "aws/=/opt/arc/plugins/aws/bin.cjs?manifest=/opt/arc/plugins/aws/manifest.json&config=/opt/arc/plugins/aws/config.json"
  }
}
```

Intent: the admin API is for **runtime ergonomics** (mount, smoke-test, observe, then
either decide to persist via env or unmount). Making API mounts persist by writing to
some side-channel state file would create two sources of truth — env vs file — and the
disagreement story has no good ending. One source of truth (env) per restart.

### 6. Out of scope (called out so we don't pretend otherwise)

- **Bulk operations.** No `POST /v1/sys/plugins/mounts` body that takes an array. One
  mount per call; tooling loops at its own pace. Bulk would force partial-success
  semantics that are harder to reason about than a clean per-call result.
- **Plugin reconfigure.** No `PATCH /v1/sys/plugins/mounts/:path` to change config
  without remount. Plugins' `configure()` runs once at mount; changing config means
  unmount + mount, which the existing endpoints already do.
- **Live admin trust-anchor management.** `ARC_PLUGIN_TRUST_ANCHORS` stays env-only —
  rotating publisher trust is a security-sensitive operation that should not happen
  behind a JSON POST; it deserves its own ADR if it ever does.
- **No new health-check route.** `GET /v1/sys/mounts` already lists every mount (built-
  in + plugin) with `type`, `description`, and (per #43) `declaredCapabilities`. Adding
  a parallel plugin-only listing would duplicate state. Admins discover via the existing
  endpoint and act via the new ones.

### 7. Tests

- **Unit** (controller spec): DTO validation (missing `mountPath`, missing `binPath`,
  bad shape), method→service wiring, conflict mapping (409 from underlying
  `BadRequestException` reasons).
- **E2E** (`test/plugin-admin.e2e-spec.ts`) under `ARC_DEFAULT_POLICY=deny`:
  - Subject with no policy → 403 on POST + DELETE.
  - Subject with `sudo` on `sys/plugins/` → 201 + can dispatch against the new mount
    + can DELETE it.
  - DELETE non-existent mount → 404.
  - POST with manifest-gate refusal (tamper + bad publisher pinning) → 400 with the
    same structured reason the boot path surfaces.
  - Mounted-then-restart-state: explicitly NOT verified end-to-end (no e2e test harness
    for "kill the app, boot a new one with the same env, see the plugin gone" — that's
    a property of the lifecycle, not a test the spec usefully owns).

## Consequences

- **+** Operators run the full mount lifecycle through the API without bouncing arc-
  server, which is the operational signal that came up explicitly during the OOP plugin
  release pipeline work and was deferred.
- **+** No new auth mechanism — the existing CapabilityGuard + grants policy is the
  authorization boundary, so the audit surface for "who can mount plugins" is the same
  one operators already manage.
- **−** Two ways to express plugin mount intent (env + API). The ADR mitigates by making
  the response include a copy-paste-ready env snippet, but operators **do** need to
  remember to persist after smoke-testing.
- **−** The `sudo`-required posture is strict. A future operator wanting to delegate
  "mount only well-known plugins" will need a more granular capability, which means
  either a separate verb in the arc-grants vocabulary or a publisher-allowlist hook on
  the controller. Punted on both — the strict default is the conservative starting
  point.

## Alternatives considered

- **Body-on-DELETE** instead of path segment — rejected for Vault parity and URL-cacheable
  semantics.
- **`POST /v1/sys/plugins/mount` (no plural)** — rejected; "mounts" is the resource, single
  mount is identified by path.
- **Idempotent PUT instead of POST** — rejected because mount has side effects (spawns
  process, registers in MountRegistry, allocates resources); PUT-with-same-payload
  meaning "no-op" doesn't apply cleanly.
- **`@arc/audit` device routing now** — rejected because it would invent a layer just for
  these two endpoints. When audit-device routing lands on `/v1/*` for everything (its
  own ADR), these endpoints come along for free.
