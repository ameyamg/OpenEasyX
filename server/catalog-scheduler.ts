export const DEFAULT_CATALOG_SCAN_INTERVAL_MINUTES = 60;
const MAX_TIMER_MS = 2_147_483_647;

export function catalogScanIntervalMs(value?: string): number {
  const minutes = value?.trim() ? Number(value) : DEFAULT_CATALOG_SCAN_INTERVAL_MINUTES;
  return Number.isFinite(minutes) && minutes >= 1 && minutes * 60_000 <= MAX_TIMER_MS
    ? minutes * 60_000 : DEFAULT_CATALOG_SCAN_INTERVAL_MINUTES * 60_000;
}

type ScheduledCatalog = {
  scan: () => Promise<unknown>;
  status: { running: boolean; lastScanAt: string };
};

/** Leave a full idle interval after a scan, including one started manually. */
export function scheduleCatalogScans(catalog: ScheduledCatalog, intervalMs: number, onError: (error: unknown) => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => { void run(); }, Math.min(MAX_TIMER_MS, delay));
    timer.unref();
  };
  const run = async () => {
    const lastScanAt = Date.parse(catalog.status.lastScanAt);
    const remaining = intervalMs - (Date.now() - lastScanAt);
    if (!catalog.status.running && Number.isFinite(remaining) && remaining > 0) { schedule(remaining); return; }
    try { await catalog.scan(); }
    catch (error) { onError(error); }
    finally { schedule(intervalMs); }
  };
  schedule(250);
  return () => { stopped = true; clearTimeout(timer); };
}
