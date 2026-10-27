import { describe, expect, it, vi } from "vitest";
import { createLiveRefreshBudget, createLiveStallRecovery, liveRecoveryPosition } from "./live-stream-recovery";

function ranges(values: [number, number][]): TimeRanges {
  return { length: values.length, start: (index) => values[index][0], end: (index) => values[index][1] };
}

describe("live stream recovery", () => {
  it("returns to the latest seekable range with six seconds of safety buffer", () => {
    expect(liveRecoveryPosition(ranges([[10, 30], [100, 160]]))).toBe(154);
    expect(liveRecoveryPosition(ranges([[100, 104]]))).toBe(102);
  });

  it("does not seek until a valid live window is available", () => {
    expect(liveRecoveryPosition(ranges([]))).toBeUndefined();
    expect(liveRecoveryPosition(ranges([[10, 10]]))).toBeUndefined();
    expect(liveRecoveryPosition(ranges([[10, Infinity]]))).toBeUndefined();
  });

  it("tries the live edge once, then replaces a stale URL even if a few buffered frames replayed", () => {
    const seek = vi.fn(); const resume = vi.fn(); const refresh = vi.fn();
    const recover = createLiveStallRecovery({ seekable: () => ranges([[100, 160]]), seek, resume, refresh });
    recover();
    expect(seek).toHaveBeenCalledExactlyOnceWith(154);
    expect(resume).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    recover();
    expect(seek).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("refreshes immediately if the live window vanished or Safari rejects a seek", () => {
    const refresh = vi.fn(); const resume = vi.fn();
    createLiveStallRecovery({ seekable: () => ranges([]), seek: vi.fn(), resume, refresh })();
    createLiveStallRecovery({ seekable: () => ranges([[100, 160]]), seek: () => { throw new Error("Unseekable"); }, resume, refresh })();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(resume).not.toHaveBeenCalled();
  });

  it("bounds repeated URL refreshes across recreated monitors and permits recovery later", () => {
    const budget = createLiveRefreshBudget();
    expect(budget.take(0)).toBe(true);
    expect(budget.take(12_000)).toBe(true);
    expect(budget.take(24_000)).toBe(true);
    expect(budget.take(36_000)).toBe(false);
    expect(budget.take(60_000)).toBe(true);
    expect(budget.take(61_000)).toBe(false);
    budget.reset();
    expect(budget.take(62_000)).toBe(true);
  });
});
