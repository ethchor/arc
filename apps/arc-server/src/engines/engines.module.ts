import { Logger, Module } from "@nestjs/common";
import {
  MountRegistry,
  type KvEngine,
  type PkiEngine,
  type SecretsEngine,
  type TransitEngine,
} from "@arc/secrets-engine";
import {
  OpenBaoClient,
  OpenBaoKvEngine,
  OpenBaoPkiEngine,
  OpenBaoTransitEngine,
} from "@arc/openbao-adapter";
import { EnginesController } from "./engines.controller";
import {
  ENGINES_CONFIG,
  EnginesService,
  type EnginesConfig,
} from "./engines.service";

/**
 * Build the Engine-A runtime config once at boot from env. Gating Engine-A on `BAO_ADDR`
 * keeps Engine-B (the zero-knowledge vault) working without an OpenBao install — `pnpm
 * test` and a fresh dev checkout both boot fine, and any `/v1/*` request returns a 503
 * with a clear "Engine-A is not configured" payload (see {@link EnginesService}).
 *
 * Mounts default to the same paths OpenBao's dev mode uses, so an existing Vault SDK
 * pointed at `secret/...` or `transit/...` works against arc-server unchanged.
 */
export function buildEnginesConfig(): EnginesConfig {
  const logger = new Logger("EnginesModule");
  const addr = process.env.BAO_ADDR;
  const token = process.env.BAO_TOKEN;
  const namespace = process.env.BAO_NAMESPACE;
  const registry = new MountRegistry();
  const enginesByMount = new Map<string, SecretsEngine>();

  if (!addr) {
    logger.log("Engine-A disabled (BAO_ADDR unset); /v1/* will return 503");
    return { client: null, registry, enginesByMount };
  }

  const client = new OpenBaoClient({ addr, token, namespace });

  const kv: KvEngine = new OpenBaoKvEngine(client, "secret");
  registry.mount({ path: "secret/", type: "kv-v2", description: "KV v2 (OpenBao)" });
  enginesByMount.set("secret/", kv);

  const transit: TransitEngine = new OpenBaoTransitEngine(client, "transit");
  registry.mount({ path: "transit/", type: "transit", description: "Transit (OpenBao)" });
  enginesByMount.set("transit/", transit);

  const pki: PkiEngine = new OpenBaoPkiEngine(client, "pki");
  registry.mount({ path: "pki/", type: "pki", description: "PKI (OpenBao)" });
  enginesByMount.set("pki/", pki);

  logger.log(
    `Engine-A enabled (addr=${addr}, mounts=${[...enginesByMount.keys()].join(", ")})`,
  );
  return { client, registry, enginesByMount };
}

@Module({
  controllers: [EnginesController],
  providers: [
    { provide: ENGINES_CONFIG, useFactory: buildEnginesConfig },
    EnginesService,
  ],
  exports: [EnginesService],
})
export class EnginesModule {}
