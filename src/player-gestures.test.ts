import { afterEach, describe, expect, it, vi } from "vitest";
import { clampZoom, createPlayerGestures, NO_ZOOM, pinchZoom, type GesturePoint } from "./player-gestures";

function setup(zoomed = false) {
  const actions = { tap: vi.fn(), doubleTap: vi.fn(), holdStart: vi.fn(), holdEnd: vi.fn(), pinch: vi.fn(), pinchEnd: vi.fn(), pan: vi.fn(), panEnd: vi.fn() };
  const gestures = createPlayerGestures({ width: () => 400, zoomed: () => zoomed, actions });
  let clock = 0;
  const at = (x: number, y = 100, id = 1, pointerType = "touch"): GesturePoint => ({ id, x, y, pointerType, time: clock });
  const tap = (x: number, pointerType = "touch") => { gestures.down(at(x, 100, 1, pointerType)); clock += 60; vi.advanceTimersByTime(60); gestures.up(at(x, 100, 1, pointerType)); };
  const wait = (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); };
  return { actions, gestures, at, tap, wait };
}

afterEach(() => vi.useRealTimers());

describe("player touch gestures", () => {
  it("toggles the controls with a single tap, after the double-tap window", () => {
    vi.useFakeTimers();
    const { actions, tap, wait } = setup();
    tap(200);
    expect(actions.tap).not.toHaveBeenCalled();
    wait(300);
    expect(actions.tap).toHaveBeenCalledWith("touch");
    expect(actions.doubleTap).not.toHaveBeenCalled();
  });

  it("seeks forward on the right and back on the left with a double tap, and keeps a streak going", () => {
    vi.useFakeTimers();
    const { actions, tap, wait } = setup();
    tap(320); wait(120); tap(320);
    expect(actions.doubleTap).toHaveBeenLastCalledWith("right", "touch");
    wait(150); tap(320);
    expect(actions.doubleTap).toHaveBeenCalledTimes(2);
    wait(600);
    tap(60); wait(100); tap(60);
    expect(actions.doubleTap).toHaveBeenLastCalledWith("left", "touch");
    wait(600);
    expect(actions.tap).not.toHaveBeenCalled();
  });

  it("does not combine taps on different sides into a double tap", () => {
    vi.useFakeTimers();
    const { actions, tap, wait } = setup();
    tap(60); wait(100); tap(340); wait(400);
    expect(actions.doubleTap).not.toHaveBeenCalled();
    expect(actions.tap).toHaveBeenCalledTimes(1);
  });

  it("plays at double speed while the right side is held and never treats the release as a tap", () => {
    vi.useFakeTimers();
    const { actions, gestures, at, wait } = setup();
    gestures.down(at(330)); wait(500);
    expect(actions.holdStart).toHaveBeenCalledOnce();
    wait(2000); gestures.up(at(330)); wait(400);
    expect(actions.holdEnd).toHaveBeenCalledOnce();
    expect(actions.tap).not.toHaveBeenCalled();
  });

  it("does not speed up when the left side is held or the finger moves", () => {
    vi.useFakeTimers();
    const { actions, gestures, at, wait } = setup();
    gestures.down(at(60)); wait(600); gestures.up(at(60));
    gestures.down(at(330)); gestures.move(at(330, 160)); wait(600); gestures.up(at(330, 160)); wait(400);
    expect(actions.holdStart).not.toHaveBeenCalled();
  });

  it("reports a two-finger pinch and never a tap or hold", () => {
    vi.useFakeTimers();
    const { actions, gestures, at, wait } = setup();
    gestures.down(at(150, 100, 1)); gestures.down(at(250, 100, 2));
    gestures.move(at(100, 100, 1)); gestures.move(at(300, 100, 2));
    expect(actions.pinch).toHaveBeenLastCalledWith(2, 200, 100, 200, 100);
    gestures.up(at(100, 100, 1)); gestures.up(at(300, 100, 2)); wait(600);
    expect(actions.pinchEnd).toHaveBeenCalledOnce();
    expect(actions.tap).not.toHaveBeenCalled();
    expect(actions.holdStart).not.toHaveBeenCalled();
  });

  it("pans with one finger only while zoomed", () => {
    vi.useFakeTimers();
    const zoomed = setup(true);
    zoomed.gestures.down(zoomed.at(200)); zoomed.gestures.move(zoomed.at(230, 120)); zoomed.gestures.move(zoomed.at(240, 130)); zoomed.gestures.up(zoomed.at(240, 130)); zoomed.wait(400);
    expect(zoomed.actions.pan).toHaveBeenCalledTimes(2);
    expect(zoomed.actions.panEnd).toHaveBeenCalledOnce();
    expect(zoomed.actions.tap).not.toHaveBeenCalled();
    const normal = setup(false);
    normal.gestures.down(normal.at(200)); normal.gestures.move(normal.at(260, 100)); normal.gestures.up(normal.at(260, 100));
    expect(normal.actions.pan).not.toHaveBeenCalled();
  });

  it("keeps mouse clicks immediate and reports a double click", () => {
    vi.useFakeTimers();
    const { actions, tap, wait } = setup();
    tap(200, "mouse");
    expect(actions.tap).toHaveBeenCalledWith("mouse");
    wait(100); tap(190, "mouse"); // across the middle: still one double click
    expect(actions.doubleTap).toHaveBeenCalledWith("left", "mouse");
    expect(actions.tap).toHaveBeenCalledTimes(2);
  });

  it("ends a hold when the pointer is cancelled (for example by scrolling)", () => {
    vi.useFakeTimers();
    const { actions, gestures, at, wait } = setup();
    gestures.down(at(330)); wait(500); gestures.cancel(at(330));
    expect(actions.holdEnd).toHaveBeenCalledOnce();
  });

  it("ends an active speed hold when switching media", () => {
    vi.useFakeTimers();
    const { actions, gestures, at, wait } = setup();
    gestures.down(at(330)); wait(500); gestures.dispose(); gestures.dispose();
    expect(actions.holdStart).toHaveBeenCalledOnce();
    expect(actions.holdEnd).toHaveBeenCalledOnce();
    wait(400);
    expect(actions.tap).not.toHaveBeenCalled();
  });

  it("clears pending taps and double-tap streaks between media", () => {
    vi.useFakeTimers();
    const { actions, gestures, tap, wait } = setup();
    tap(330); wait(100); gestures.dispose(); tap(330); wait(400);
    expect(actions.tap).toHaveBeenCalledExactlyOnceWith("touch");
    expect(actions.doubleTap).not.toHaveBeenCalled();
  });
});

describe("pinch zoom maths", () => {
  it("keeps the point between the fingers in place and the video covering the surface", () => {
    const zoom = pinchZoom(NO_ZOOM, 2, 100, 50, 100, 50, 400, 200);
    expect(zoom).toEqual({ scale: 2, x: -100, y: -50 });
    expect(pinchZoom(NO_ZOOM, 9, 0, 0, 0, 0, 400, 200).scale).toBe(4);
    expect(pinchZoom({ scale: 2, x: -100, y: -50 }, 0.3, 100, 50, 100, 50, 400, 200)).toEqual(NO_ZOOM);
    expect(clampZoom({ scale: 2, x: 50, y: -500 }, 400, 200)).toEqual({ scale: 2, x: 0, y: -200 });
  });
});
