import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogScanIntervalMs, scheduleCatalogScans } from "./catalog-scheduler.js";

const HOUR = 60 * 60_000;
afterEach(() => vi.useRealTimers());

function setup(scanTask: () => Promise<unknown> = async () => {}) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const status = { running: false, lastScanAt: "" };
  const scan = vi.fn(async () => {
    status.running = true;
    try { await scanTask(); status.lastScanAt = new Date().toISOString(); }
    finally { status.running = false; }
  });
  const error = vi.fn();
  const stop = scheduleCatalogScans({ scan, status }, HOUR, error);
  return { scan, status, stop, error };
}

describe("full catalog scan scheduling", () => {
  it("defaults to an hour and safely handles invalid environment values", () => {
    for (const value of [undefined, "", "bad", "0", "-1", "Infinity", "999999999"]) expect(catalogScanIntervalMs(value)).toBe(HOUR);
    expect(catalogScanIntervalMs("120")).toBe(2 * HOUR);
    expect(catalogScanIntervalMs("10")).toBe(10 * 60_000);
  });

  it("runs at startup and leaves an hour before the next scan", async () => {
    const { scan, stop } = setup();
    await vi.advanceTimersByTimeAsync(249); expect(scan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(scan).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HOUR - 1); expect(scan).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(scan).toHaveBeenCalledTimes(2);
    stop();
  });

  it("waits for a long scan to finish before starting its idle interval", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { scan, stop } = setup(() => gate);
    await vi.advanceTimersByTimeAsync(250 + 2 * HOUR);
    expect(scan).toHaveBeenCalledOnce();
    release(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HOUR - 1); expect(scan).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(scan).toHaveBeenCalledTimes(2);
    stop();
  });

  it("postpones a scheduled scan after a recent manual scan", async () => {
    const { scan, status, stop } = setup();
    await vi.advanceTimersByTimeAsync(250 + HOUR / 2);
    status.lastScanAt = new Date().toISOString();
    await vi.advanceTimersByTimeAsync(HOUR / 2); expect(scan).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HOUR / 2); expect(scan).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps retrying at the configured interval after a failed scan", async () => {
    const { scan, error, stop } = setup(async () => { throw new Error("Disk unavailable"); });
    await vi.advanceTimersByTimeAsync(250); expect(error).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HOUR); expect(scan).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not schedule another scan when shutdown happens during a running scan", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { scan, stop } = setup(() => gate);
    await vi.advanceTimersByTimeAsync(250); stop(); release();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(scan).toHaveBeenCalledOnce();
  });
});
