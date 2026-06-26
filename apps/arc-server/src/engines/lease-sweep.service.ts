import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ENGINES_CONFIG, type EnginesConfig } from "./engines.service";

/** Default cadence: sweep every 5 minutes. Set `ARC_LEASE_SWEEP_INTERVAL_MS=0` to disable. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Default retention: keep terminal (expired/revoked) leases for 24h before pruning, so the
 * operator Leases screen can still show what recently happened. Tune with
 * `ARC_LEASE_RETENTION_MS`.
 */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Background janitor for the persisted lease registry (#113). The in-memory `LeaseManager`
 * never needed one — process restart cleared terminal leases — but the `vault_leases` table
 * grows forever without pruning. This service periodically calls {@link LeaseManager.sweep}
 * to drop expired/revoked leases older than the retention window.
 *
 * It is deliberately tolerant: a sweep that throws (transient DB blip) is logged and the
 * interval keeps ticking; runs never overlap (a slow sweep skips the next tick rather than
 * stacking). The timer is `unref`'d so it never holds the process open in tests or on a
 * graceful drain.
 */
@Injectable()
export class LeaseSweepService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LeaseSweepService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly intervalMs = readPositiveIntEnv(
    "ARC_LEASE_SWEEP_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  );
  private readonly retentionMs = readPositiveIntEnv(
    "ARC_LEASE_RETENTION_MS",
    DEFAULT_RETENTION_MS,
  );

  constructor(@Inject(ENGINES_CONFIG) private readonly config: EnginesConfig) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) {
      this.logger.log("lease sweep disabled (ARC_LEASE_SWEEP_INTERVAL_MS=0)");
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    // Don't let the janitor's timer keep the event loop (or a Jest worker) alive.
    this.timer.unref?.();
    this.logger.log(
      `lease sweep every ${this.intervalMs}ms, retention ${this.retentionMs}ms`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep pass. Exposed (not private) so a test can drive a deterministic prune without
   * waiting for the interval. Reentrancy-guarded: if a previous pass is still in flight the
   * call is a no-op.
   */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const removed = await this.config.leases.sweep(Date.now(), {
        olderThanMs: this.retentionMs,
      });
      if (removed.length > 0) {
        this.logger.log(`swept ${removed.length} terminal lease(s)`);
      }
      return removed.length;
    } catch (err) {
      this.logger.warn(`lease sweep failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}

/** Parse a non-negative integer env var, falling back to `fallback` on absent/invalid. */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
