/**
 * Background service-worker tests. Exercises the auto-lock TTL logic + `arc:status`
 * response shape via the `__internal` hooks the worker exports. We don't spin a real
 * chrome.runtime — the message-dispatch code is straight-line and would only retest the
 * declared types. The interesting state machine is lock / touch / status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the SDK + chrome runtime BEFORE importing the worker module so its top-level
// `chrome.runtime.onMessage.addListener` call doesn't blow up.
vi.mock("@arc/sdk", () => ({
  VaultClient: vi.fn().mockImplementation(() => ({
    devLogin: vi.fn(),
    unlock: vi.fn(),
    listVaults: vi.fn().mockResolvedValue([]),
    pull: vi.fn().mockResolvedValue({ items: [] }),
  })),
}));

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: { onMessage: { addListener: vi.fn() } },
  storage: { session: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
};

const worker = await import("../src/background");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  worker.__internal.lockNow();
});

describe("auto-lock TTL", () => {
  it("reports unlocked + a positive lockInSeconds after a successful unlock", () => {
    worker.__internal.setAutolockTtl(60);
    worker.__internal.unlockWithMock({} as never, []);
    const s = worker.__internal.status();
    expect(s.unlocked).toBe(true);
    expect(s.lockInSeconds).toBeGreaterThan(58);
    expect(s.lockInSeconds).toBeLessThanOrEqual(60);
  });

  it("auto-locks after TTL elapses without activity", () => {
    worker.__internal.setAutolockTtl(60);
    worker.__internal.unlockWithMock({} as never, []);
    expect(worker.__internal.status().unlocked).toBe(true);

    vi.advanceTimersByTime(60_000 + 1);
    const after = worker.__internal.status();
    expect(after.unlocked).toBe(false);
    expect(after.lockInSeconds).toBeNull();
  });

  it("explicit lockNow() drops state immediately", () => {
    worker.__internal.setAutolockTtl(60);
    worker.__internal.unlockWithMock({} as never, []);
    worker.__internal.lockNow();
    expect(worker.__internal.status().unlocked).toBe(false);
  });

  it("status returns lockInSeconds=null when locked (no leak of past TTL)", () => {
    expect(worker.__internal.status()).toEqual({ unlocked: false, lockInSeconds: null });
  });
});
