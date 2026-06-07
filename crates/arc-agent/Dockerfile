# syntax=docker/dockerfile:1.7
# arc-agent image — built from the repo root:
#
#   docker build -f crates/arc-agent/Dockerfile -t arc-agent .
#
# Two-stage: builder pins the Rust toolchain via rust:slim, runtime is a distroless-style
# Debian slim image since we statically link rustls (no openssl in the runtime).
ARG RUST_VERSION=1.83

# ---------------------------------------------------------------------------
FROM rust:${RUST_VERSION}-bookworm AS build
WORKDIR /repo
COPY . .
RUN cargo build --release --manifest-path crates/arc-agent/Cargo.toml --bin arc-agent

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
# ca-certificates is the only system dep we need (TLS roots for arc-server).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 arc \
 && useradd --system --uid 10001 --gid arc --home-dir /app --shell /usr/sbin/nologin arc

COPY --from=build /repo/crates/arc-agent/target/release/arc-agent /usr/local/bin/arc-agent

USER arc
WORKDIR /app

ENTRYPOINT ["/usr/local/bin/arc-agent"]
CMD ["--help"]
