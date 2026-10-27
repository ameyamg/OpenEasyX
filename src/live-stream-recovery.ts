const LIVE_EDGE_OFFSET_SECONDS = 6;
const REFRESH_WINDOW_MS = 60_000;
const MAX_REFRESHES = 3;

/** Seek inside the newest live window, keeping a buffer instead of chasing its last frame. */
export function liveRecoveryPosition(seekable: TimeRanges): number | undefined {
  if (!seekable.length) return undefined;
  const start = seekable.start(seekable.length - 1);
  const end = seekable.end(seekable.length - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return end - Math.min(LIVE_EDGE_OFFSET_SECONDS, (end - start) / 2);
}

export function createLiveStallRecovery(options: {
  seekable: () => TimeRanges;
  seek: (seconds: number) => void;
  resume: () => void;
  refresh: () => void;
}) {
  let nudged = false;
  return () => {
    // Seek at most once per URL. Replaying a few buffered frames must not keep
    // resetting the watchdog and trap Safari in an old, frozen live window.
    if (!nudged) {
      nudged = true;
      const target = liveRecoveryPosition(options.seekable());
      if (target !== undefined) {
        try { options.seek(target); options.resume(); return; }
        catch { /* The seekable window may have moved. Resolve a fresh URL instead. */ }
      }
    }
    options.refresh();
  };
}

/** Keep automatic URL refreshes bounded even though each URL creates a new player monitor. */
export function createLiveRefreshBudget() {
  let refreshes: number[] = [];
  return {
    take(now = Date.now()) {
      refreshes = refreshes.filter((time) => now - time < REFRESH_WINDOW_MS);
      if (refreshes.length >= MAX_REFRESHES) return false;
      refreshes.push(now);
      return true;
    },
    reset() { refreshes = []; },
  };
}
