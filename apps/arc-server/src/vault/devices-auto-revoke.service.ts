import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { VaultService } from "./vault.service";

/**
 * Periodically revokes approved-but-stale devices.
 *
 * Gated entirely on environment so dev/test boot with the feature off:
 *   - ARC_DEVICE_INACTIVE_DAYS     — number of days of inactivity before auto-revoke
 *                                     (0 / unset = feature OFF; revocation only happens
 *                                     when an admin or user explicitly asks).
 *   - ARC_DEVICE_AUTO_REVOKE_INTERVAL_MS — how often to scan. Default 1 hour.
 *
 * Trusted devices (`trusted: true`) are skipped by `VaultService.autoRevokeStaleDevices`
 * regardless of inactivity. Pending devices (`approved: false`) are also skipped — they
 * have their own onboarding/approval cleanup story.
 *
 * The scheduler is a plain `setInterval` to keep `@nestjs/schedule` out of the dep graph;
 * the cost of a few-line scheduler over an extra runtime dep isn't worth it here.
 */
@Injectable()
export class DevicesAutoRevokeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DevicesAutoRevokeService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly vault: VaultService) {}

  onModuleInit(): void {
    const intervalMs = this.scanIntervalMs();
    const inactiveMs = this.inactiveBeforeMs();
    if (inactiveMs <= 0) {
      this.logger.log("auto-revoke disabled (ARC_DEVICE_INACTIVE_DAYS unset or 0)");
      return;
    }
    this.logger.log(
      `auto-revoke enabled (inactive_days=${inactiveMs / 86_400_000}, scan_interval_ms=${intervalMs})`,
    );
    // First scan is deferred by one interval to avoid contending with startup; many tests
    // call `runOnce()` directly rather than waiting on the timer.
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => this.logger.error(`auto-revoke scan failed: ${err}`));
    }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run a single scan immediately. Public so admin tooling + tests can trigger it. */
  async runOnce(): Promise<{ revokedIds: string[] }> {
    const inactiveMs = this.inactiveBeforeMs();
    if (inactiveMs <= 0) return { revokedIds: [] };
    const result = await this.vault.autoRevokeStaleDevices(inactiveMs);
    if (result.revokedIds.length > 0) {
      this.logger.log(`auto-revoke removed ${result.revokedIds.length} devices: ${result.revokedIds.join(", ")}`);
    }
    return result;
  }

  /** `true` when the auto-revoke feature is configured to run. */
  get enabled(): boolean {
    return this.inactiveBeforeMs() > 0;
  }

  private inactiveBeforeMs(): number {
    const days = Number(process.env.ARC_DEVICE_INACTIVE_DAYS ?? 0);
    if (!Number.isFinite(days) || days <= 0) return 0;
    return Math.floor(days * 86_400_000);
  }

  private scanIntervalMs(): number {
    const ms = Number(process.env.ARC_DEVICE_AUTO_REVOKE_INTERVAL_MS ?? 3_600_000);
    if (!Number.isFinite(ms) || ms < 1_000) return 3_600_000;
    return Math.floor(ms);
  }
}
