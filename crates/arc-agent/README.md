# `arc-agent`

Workload sidecar for arc. Authenticates with arc-server, fetches secrets, renders templated
config files, and refreshes dynamic credentials before lease expiry.

Two run modes:

- **Init container** — `arc-agent run --config /etc/arc-agent.yaml --once`. Fetches every
  configured secret, renders the templates, writes the files, exits non-zero on any
  failure. Pairs with a container that depends on the rendered files being on disk before
  the workload starts.
- **Sidecar** — `arc-agent run --config /etc/arc-agent.yaml`. Same first pass, then stays
  running and re-issues / re-renders before each sink's next-tick. On a successful change,
  fires the sink's `on_change` (a command or signal-to-PID).

## Config

YAML, one file per workload. See `src/config.rs` for the full schema.

```yaml
arc:
  server: https://arc.svc.cluster.local:3001
  auth:
    type: kubernetes        # only `kubernetes` for now
    mount: kubernetes
    role: web
    # token_file defaults to the in-cluster SA token path

sinks:
  - id: db-config
    template_file: /etc/arc/templates/db.conf.tmpl
    output_path: /etc/app/db.conf
    mode: "0640"
    source:
      type: kv_get
      mount: secret
      path: app/prod/db
    refresh_interval_seconds: 300
    on_change:
      command: ["/usr/local/bin/reload-config"]

  - id: aws-creds
    template_file: /etc/arc/templates/aws.tmpl
    output_path: /etc/app/aws.env
    source:
      type: dynamic_creds
      mount: aws
      role: deployer
      ttl_seconds: 900
    refresh_lead_seconds: 60
    on_change:
      signal: SIGHUP
      pid_file: /var/run/app.pid
```

## Templates

[Tera](https://keats.github.io/tera/docs/) (Jinja-style). Two variables in scope:

- `data` — the JSON object returned by arc. For KV: the secret's `data.data`. For dynamic
  credentials: the issuance `data` (access keys, tokens, etc.).
- `meta` — for KV: `{ version }`. For dynamic credentials: `{ lease_id, lease_duration }`.

```jinja2
DATABASE_URL=postgres://{{ data.username }}:{{ data.password }}@{{ data.host }}/{{ data.db }}
# rendered from KV version {{ meta.version }}
```

**Autoescape is off** — these templates render `.env` / `.conf` / `.ini` files, not HTML.
Missing dotted fields error out (the typo `{{ data.passw0rd }}` fails the sink loudly
instead of silently producing `PASSWORD=` in your config).

## Trust boundary

The agent carries an arc JWT issued by the configured auth method. **arc-server's
`@arc/grants` is the only policy decision point** — arc-agent does not infer authorization
locally and does not retry-with-different-creds on 403. A 401 (token revoked) triggers a
single re-login + retry; a 403 propagates immediately.

The cached JWT is held in a `String` that's zeroized on drop. The pod's ServiceAccount
token is read fresh on each login (no long-lived cache of the SA token in process).

## Build

```sh
cargo build --release --manifest-path crates/arc-agent/Cargo.toml
```

A self-contained ~14 MB binary lands at `crates/arc-agent/target/release/arc-agent`. The
shipped Dockerfile produces a distroless-style runtime image (`arc-agent:dev`).

## Tests

```sh
cargo test --manifest-path crates/arc-agent/Cargo.toml
```

10 tests across:
- Config parse + validate (defaults, duplicate-id rejection, on-change shape rejection).
- Template rendering (dotenv-style, dynamic-cred lease metadata, missing-field errors).
- Integration via `wiremock` — login → KV render to file with correct mode; dynamic-cred
  issue + render + lease metadata; 403 propagation with no file written.
