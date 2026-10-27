// Touch gestures for the video surface, kept free of React and the DOM so they can be tested.
//
// Touch / pen:
//   tap                      → toggle the controls
//   double tap left / right  → seek -10 s / +10 s (each further tap adds another step)
//   press and hold right     → play at 2× while held
//   two-finger pinch         → zoom (and drag with one finger while zoomed)
// Mouse:
//   click → play / pause, double click → fullscreen, press and hold right → 2×

export type GestureSide = "left" | "right";
export type GesturePoint = { id: number; x: number; y: number; pointerType: string; time: number };
export type GestureActions = {
  tap: (pointerType: string) => void;
  doubleTap: (side: GestureSide, pointerType: string) => void;
  holdStart: () => void;
  holdEnd: () => void;
  /** Two-finger pinch: absolute scale factor since the gesture began and the current midpoint. */
  pinch: (scale: number, midX: number, midY: number, startMidX: number, startMidY: number) => void;
  pinchEnd: () => void;
  /** One-finger drag (only reported while zoomed). */
  pan: (dx: number, dy: number) => void;
  panEnd: () => void;
};
export type GestureOptions = {
  width: () => number;
  zoomed: () => boolean;
  actions: GestureActions;
  doubleTapMs?: number;
  holdMs?: number;
  moveTolerance?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export const DOUBLE_TAP_MS = 300;
export const HOLD_MS = 450;
export const SEEK_STEP_SECONDS = 10;
export const HOLD_PLAYBACK_RATE = 2;
export const MAX_ZOOM = 4;

export function createPlayerGestures(options: GestureOptions) {
  const doubleTapMs = options.doubleTapMs ?? DOUBLE_TAP_MS;
  const holdMs = options.holdMs ?? HOLD_MS;
  const tolerance = options.moveTolerance ?? 14;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const { actions } = options;

  const pointers = new Map<number, GesturePoint & { startX: number; startY: number }>();
  let holdTimer: unknown; let holding = false;
  let tapTimer: unknown; let lastTap: { x: number; y: number; time: number; pointerType: string } | undefined;
  let moved = false; let panning = false; let consumed = false;
  let pinch: { distance: number; midX: number; midY: number } | undefined;

  const side = (x: number): GestureSide => x < options.width() / 2 ? "left" : "right";
  const cancelHold = () => { if (holdTimer !== undefined) clearTimer(holdTimer); holdTimer = undefined; };
  const cancelTap = () => { if (tapTimer !== undefined) clearTimer(tapTimer); tapTimer = undefined; };
  const endHold = () => { cancelHold(); if (holding) { holding = false; actions.holdEnd(); } };
  const twoPointers = () => { const [a, b] = [...pointers.values()]; return { a, b }; };
  const distance = () => { const { a, b } = twoPointers(); return Math.hypot(a.x - b.x, a.y - b.y); };
  const midpoint = () => { const { a, b } = twoPointers(); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };

  function down(point: GesturePoint) {
    pointers.set(point.id, { ...point, startX: point.x, startY: point.y });
    if (pointers.size === 1) {
      moved = false; panning = false; consumed = false;
      if (side(point.x) === "right") {
        holdTimer = setTimer(() => { holdTimer = undefined; if (pointers.size === 1 && !moved) { holding = true; consumed = true; cancelTap(); lastTap = undefined; actions.holdStart(); } }, holdMs);
      }
    } else if (pointers.size === 2 && point.pointerType !== "mouse") {
      endHold(); cancelTap(); lastTap = undefined; consumed = true;
      if (panning) { panning = false; actions.panEnd(); }
      const mid = midpoint();
      pinch = { distance: Math.max(1, distance()), midX: mid.x, midY: mid.y };
    }
  }

  function move(point: GesturePoint) {
    const current = pointers.get(point.id); if (!current) return;
    const dx = point.x - current.x; const dy = point.y - current.y;
    current.x = point.x; current.y = point.y;
    if (pinch && pointers.size >= 2) {
      const mid = midpoint();
      actions.pinch(distance() / pinch.distance, mid.x, mid.y, pinch.midX, pinch.midY);
      return;
    }
    if (pointers.size !== 1 || holding) return;
    if (!moved && Math.hypot(point.x - current.startX, point.y - current.startY) > tolerance) {
      moved = true; cancelHold();
      if (options.zoomed() && point.pointerType !== "mouse") { panning = true; consumed = true; }
    }
    if (panning) actions.pan(dx, dy);
  }

  function up(point: GesturePoint) {
    const current = pointers.get(point.id); if (!current) return;
    pointers.delete(point.id);
    if (pinch) {
      if (pointers.size < 2) { pinch = undefined; actions.pinchEnd(); }
      return;
    }
    if (pointers.size) return;
    if (panning) { panning = false; actions.panEnd(); return; }
    if (holding) { endHold(); return; }
    cancelHold();
    if (consumed || moved) return;
    const tapSide = side(point.x);
    const previous = lastTap;
    const isDouble = previous && previous.pointerType === point.pointerType && point.time - previous.time <= doubleTapMs
      && Math.hypot(point.x - previous.x, point.y - previous.y) < 80 && (point.pointerType === "mouse" || side(previous.x) === tapSide);
    if (point.pointerType === "mouse") {
      // Desktop keeps click = play/pause at once; a double click is reported for fullscreen.
      actions.tap("mouse");
      if (isDouble) { lastTap = undefined; actions.doubleTap(tapSide, "mouse"); }
      else lastTap = { x: point.x, y: point.y, time: point.time, pointerType: "mouse" };
      return;
    }
    if (isDouble) {
      cancelTap();
      // Keep the streak alive: every further quick tap on the same side seeks again.
      lastTap = { x: point.x, y: point.y, time: point.time, pointerType: point.pointerType };
      actions.doubleTap(tapSide, point.pointerType);
      return;
    }
    lastTap = { x: point.x, y: point.y, time: point.time, pointerType: point.pointerType };
    cancelTap();
    tapTimer = setTimer(() => { tapTimer = undefined; actions.tap(point.pointerType); }, doubleTapMs);
  }

  function cancel(point: GesturePoint) {
    pointers.delete(point.id);
    if (pinch && pointers.size < 2) { pinch = undefined; actions.pinchEnd(); }
    if (panning && !pointers.size) { panning = false; actions.panEnd(); }
    if (!pointers.size) endHold();
  }

  function dispose() {
    endHold(); cancelTap(); pointers.clear(); lastTap = undefined;
    if (pinch) { pinch = undefined; actions.pinchEnd(); }
    if (panning) { panning = false; actions.panEnd(); }
    moved = false; consumed = false;
  }

  return { down, move, up, cancel, dispose };
}

export type ZoomState = { scale: number; x: number; y: number };
export const NO_ZOOM: ZoomState = { scale: 1, x: 0, y: 0 };

/** Keep the zoomed video covering the surface: no empty borders when panning. */
export function clampZoom(zoom: ZoomState, width: number, height: number): ZoomState {
  const scale = Math.min(MAX_ZOOM, Math.max(1, zoom.scale));
  if (scale <= 1.001) return NO_ZOOM;
  return { scale, x: Math.min(0, Math.max(width - width * scale, zoom.x)), y: Math.min(0, Math.max(height - height * scale, zoom.y)) };
}

/** New zoom for a pinch: the content point under the starting midpoint follows the fingers. */
export function pinchZoom(start: ZoomState, factor: number, midX: number, midY: number, startMidX: number, startMidY: number, width: number, height: number): ZoomState {
  const scale = Math.min(MAX_ZOOM, Math.max(1, start.scale * factor));
  const contentX = (startMidX - start.x) / start.scale; const contentY = (startMidY - start.y) / start.scale;
  return clampZoom({ scale, x: midX - contentX * scale, y: midY - contentY * scale }, width, height);
}
