import { Logger } from "@nestjs/common";

/**
 * Operator config for account login (issue #144 / BL-C4). Account login is the *sync* gate
 * only — doc 06 §6.1 keeps it strictly separate from vault unlock, which is the
 * master-password gate. That separation is what makes a stolen JWT worth ciphertext and
 * nothing more, so account auth must never be derived from the master password.
 *
 *   `ARC_OIDC_ISSUERS`   — comma-separated allowlist, e.g.
 *                          "https://accounts.google.com,https://token.actions.githubusercontent.com"
 *   `ARC_OIDC_AUDIENCES` — comma-separated client IDs this deployment owns.
 *   `ARC_OIDC_ADOPT_UNBOUND` — "true" lets a verified OIDC identity claim a pre-existing
 *                          account that has the same email and no bound identity. Off by
 *                          default: those rows are exactly what the gated dev-login creates,
 *                          so adopting them automatically would re-introduce the takeover
 *                          #144 exists to close. Turn it on only for a one-off migration.
 */
export interface OidcAccountConfig {
  issuers: readonly string[];
  audiences: readonly string[];
  adoptUnbound: boolean;
  clockSkewSeconds: number;
}

function csv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildOidcAccountConfig(env: NodeJS.ProcessEnv = process.env): OidcAccountConfig {
  const issuers = csv(env.ARC_OIDC_ISSUERS);
  const audiences = csv(env.ARC_OIDC_AUDIENCES);
  const adoptUnbound = env.ARC_OIDC_ADOPT_UNBOUND === "true";
  const skewRaw = Number(env.ARC_OIDC_CLOCK_SKEW_SECONDS ?? 60);
  const clockSkewSeconds = Number.isFinite(skewRaw) && skewRaw >= 0 ? skewRaw : 60;

  const log = new Logger("OidcAccountConfig");
  // An issuer allowlist with no audiences would accept a token minted for *any* client at
  // that issuer — the classic confused-deputy. Refuse to half-configure.
  if (issuers.length > 0 && audiences.length === 0) {
    throw new Error(
      "ARC_OIDC_ISSUERS is set but ARC_OIDC_AUDIENCES is empty. Without an audience check, an " +
        "ID token issued for any other client at the same issuer would be accepted. Set " +
        "ARC_OIDC_AUDIENCES to this deployment's client id(s).",
    );
  }
  if (issuers.length === 0 && env.NODE_ENV === "production") {
    log.warn(
      "ARC_OIDC_ISSUERS is unset in production — account login via POST /auth/oidc/login is " +
        "disabled and there is no other production login path.",
    );
  }
  if (adoptUnbound) {
    log.warn(
      "ARC_OIDC_ADOPT_UNBOUND=true — a verified OIDC identity may claim an existing account " +
        "with a matching email and no bound identity. Intended for one-off migration only.",
    );
  }
  return { issuers, audiences, adoptUnbound, clockSkewSeconds };
}
