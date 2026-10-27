import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  monitorVideoStalls, noteRenderedVideoFrame, noteVideoStallRecovery, shouldRecoverVideoStall,
  VIDEO_STALL_MAX_RECOVERIES, videoStallState,
} from "./video-stall-recovery";

const playing = {
  now: 5_000, currentTime: 8, duration: 120, paused: false, ended: false,
  seeking: false, readyState: 4, hidden: false,
};

describe("video stall recovery", () => {
  it("detects audio time advancing while rendered video frames remain frozen", () => {
    const state = videoStallState(0, 2);
    expect(shouldRecoverVideoStall(state, playing)).toBe(true);
  });

  it("does not interfere with normal buffering, seeking, pausing, or hidden tabs", () => {
    const state = videoStallState(0, 2);
    expect(shouldRecoverVideoStall(state, { ...playing, readyState: 2 })).toBe(false);
    expect(shouldRecoverVideoStall(state, { ...playing, seeking: true })).toBe(false);
    expect(shouldRecoverVideoStall(state, { ...playing, paused: true })).toBe(false);
    expect(shouldRecoverVideoStall(state, { ...playing, hidden: true })).toBe(false);
  });

  it("uses a cooldown, limits repeated retries, and resets after a rendered frame", () => {
    const state = videoStallState(0, 2);
    noteVideoStallRecovery(state, 5_000, 8);
    expect(shouldRecoverVideoStall(state, { ...playing, now: 9_500, currentTime: 12 })).toBe(false);
    for (let retry = 1; retry < VIDEO_STALL_MAX_RECOVERIES; retry += 1) noteVideoStallRecovery(state, 20_000 + retry * 11_000, 12 + retry * 2);
    expect(shouldRecoverVideoStall(state, { ...playing, now: 60_000, currentTime: 30 })).toBe(false);
    noteRenderedVideoFrame(state, 61_000, 30);
    expect(state.consecutiveRecoveries).toBe(0);
  });
});

// Exercise the running monitor as well as the detection predicate: decoder
// resets and deferred play callbacks used to be untested.
describe("video stall monitor", () => {
  let now = 0;
  let frameCallback: FrameRequestCallback | undefined;
  let renderedFrame: VideoFrameRequestCallback | undefined;
  let element: HTMLVideoElement;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    frameCallback = undefined;
    renderedFrame = undefined;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal("window", {
      setInterval, clearInterval,
      requestAnimationFrame: vi.fn((callback) => { frameCallback = callback; return 42; }),
      cancelAnimationFrame: vi.fn(() => { frameCallback = undefined; }),
    });
    element = Object.assign(new EventTarget(), {
      currentTime: 2, duration: 120, paused: false, ended: false, seeking: false, readyState: 4,
      pause: vi.fn(() => { Object.assign(element, { paused: true }); }),
      play: vi.fn(async () => { Object.assign(element, { paused: false }); }),
      requestVideoFrameCallback: vi.fn((callback) => { renderedFrame = callback; return 7; }),
      cancelVideoFrameCallback: vi.fn(),
    }) as unknown as HTMLVideoElement;
  });

  afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function tick(time: number, mediaTime: number) {
    now = time; element.currentTime = mediaTime;
    await vi.advanceTimersByTimeAsync(1000);
  }

  it("escalates from a seek to decoder reload, then reports persistent failure", async () => {
    const reload = vi.fn(); const failed = vi.fn();
    cleanup = monitorVideoStalls(element, { reload, failed });
    await tick(5000, 8);
    expect(element.pause).toHaveBeenCalledOnce();
    expect(element.currentTime).toBeCloseTo(8.04);
    frameCallback?.(now);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await tick(16000, 19);
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(27000, 30);
    expect(reload).toHaveBeenCalledTimes(2);
    await tick(38000, 41);
    expect(failed).toHaveBeenCalledOnce();
    await tick(49000, 52);
    expect(failed).toHaveBeenCalledOnce();
  });

  it("does not resume an old media element after the player is closed", async () => {
    cleanup = monitorVideoStalls(element);
    await tick(5000, 8);
    const pending = frameCallback;
    cleanup(); cleanup = undefined;
    pending?.(now);
    expect(element.play).not.toHaveBeenCalled();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(element.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
    renderedFrame?.(6000, { mediaTime: 9 } as VideoFrameCallbackMetadata);
    expect(element.requestVideoFrameCallback).toHaveBeenCalledOnce();
  });

  it("leaves normally rendered frames alone", async () => {
    const reload = vi.fn(); const failed = vi.fn();
    cleanup = monitorVideoStalls(element, { reload, failed });
    for (let time = 1000; time <= 30000; time += 1000) {
      renderedFrame?.(time, { mediaTime: time / 1000 } as VideoFrameCallbackMetadata);
      await tick(time, time / 1000);
    }
    expect(element.pause).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("still resumes after a seek outside a moving live window is rejected", async () => {
    cleanup = monitorVideoStalls(element);
    now = 5000;
    Object.defineProperty(element, "currentTime", { get: () => 8, set: () => { throw new DOMException("Unseekable", "InvalidStateError"); } });
    await vi.advanceTimersByTimeAsync(1000);
    frameCallback?.(now);
    expect(element.play).toHaveBeenCalledOnce();
  });

  it("recovers a live stream whose picture and playback clock both stopped during buffering", async () => {
    const reload = vi.fn();
    cleanup = monitorVideoStalls(element, { live: true, reload });
    Object.assign(element, { readyState: 2, duration: Infinity });
    await tick(11_000, 2);
    expect(reload).not.toHaveBeenCalled();
    await tick(12_000, 2);
    expect(reload).toHaveBeenCalledExactlyOnceWith(1);
    expect(element.pause).not.toHaveBeenCalled();
    await tick(25_000, 2);
    expect(reload).toHaveBeenLastCalledWith(2);
  });

  it("detects a live buffering stall even without a browser frame API", async () => {
    Object.assign(element, { requestVideoFrameCallback: undefined, readyState: 1 });
    const reload = vi.fn();
    cleanup = monitorVideoStalls(element, { live: true, reload });
    await tick(13_000, 2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("gives live playback a fresh grace period after a pause or hidden tab", async () => {
    const reload = vi.fn();
    cleanup = monitorVideoStalls(element, { live: true, reload });
    Object.assign(element, { paused: true }); await tick(60_000, 2);
    Object.assign(element, { paused: false }); await tick(61_000, 2);
    expect(reload).not.toHaveBeenCalled();
    Object.assign(document, { hidden: true }); await tick(90_000, 2);
    Object.assign(document, { hidden: false }); await tick(91_000, 2);
    expect(reload).not.toHaveBeenCalled();
    await tick(103_000, 2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not mistake healthy live frames for a stall when Safari's clock stays unchanged", async () => {
    const reload = vi.fn();
    cleanup = monitorVideoStalls(element, { live: true, reload });
    for (let time = 1000; time <= 30000; time += 1000) {
      renderedFrame?.(time, { mediaTime: time / 1000 } as VideoFrameCallbackMetadata);
      await tick(time, 2);
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves healthy live playback alone when only the playback clock is available", async () => {
    Object.assign(element, { requestVideoFrameCallback: undefined });
    const reload = vi.fn();
    cleanup = monitorVideoStalls(element, { live: true, reload });
    for (let time = 1000; time <= 30000; time += 1000) await tick(time, time / 1000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not immediately restart a live after Safari suspended background timers", async () => {
    const reload = vi.fn();
    cleanup = monitorVideoStalls(element, { live: true, reload });
    now = 60_000;
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(61_000, 2);
    expect(reload).not.toHaveBeenCalled();
    await tick(73_000, 2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("bounds repeated live buffering recovery and stops when the viewer closes", async () => {
    const reload = vi.fn(); const failed = vi.fn();
    Object.assign(element, { readyState: 2 });
    cleanup = monitorVideoStalls(element, { live: true, reload, failed });
    for (let time = 12_000; time <= 60_000; time += 12_000) await tick(time, 2);
    expect(reload).toHaveBeenCalledTimes(3);
    expect(failed).toHaveBeenCalledOnce();
    cleanup(); cleanup = undefined;
    await tick(90_000, 2);
    expect(reload).toHaveBeenCalledTimes(3);
  });
});
