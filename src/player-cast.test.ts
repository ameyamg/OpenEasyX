import { describe, expect, it, vi } from "vitest";
import { chromecastSupported, observeCastPlayer, receiverUrl, unreachableFromTv } from "./player-cast";

const chrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("player casting", () => {
  it("offers Chromecast only in Chrome on a secure page", () => {
    expect(chromecastSupported({ isSecureContext: true } as never, chrome)).toBe(true);
    expect(chromecastSupported({ isSecureContext: false } as never, chrome)).toBe(false);
    expect(chromecastSupported({ isSecureContext: true } as never, safari)).toBe(false);
  });

  it("gives the TV an absolute address it can reach", () => {
    expect(receiverUrl("/api/media/abc/stream", "http://192.168.1.20:3210/watch/abc")).toBe("http://192.168.1.20:3210/api/media/abc/stream");
    expect(unreachableFromTv("http://192.168.1.20:3210/api/media/abc/stream")).toBe(false);
    expect(unreachableFromTv("http://localhost:3210/api/media/abc/stream")).toBe(true);
    expect(unreachableFromTv("http://127.0.0.1:3210/x")).toBe(true);
  });
});

function castSession(contentId = "https://nas.test/video.mp4") {
  const player = { isConnected: true, isMediaLoaded: true, currentTime: 42, duration: 100, isPaused: false };
  const listeners = new Set<() => void>();
  const controller = { addEventListener: (_type: string, callback: () => void) => listeners.add(callback), removeEventListener: (_type: string, callback: () => void) => listeners.delete(callback) };
  const session = { getMediaSession: () => ({ media: { contentId } }), getCastDevice: () => ({ friendlyName: "Living room" }) };
  const framework = { RemotePlayer: function () { return player; }, RemotePlayerController: function () { return controller; }, RemotePlayerEventType: { ANY_CHANGE: "change" } };
  const callbacks = { update: vi.fn(), pauseLocal: vi.fn(), resumeLocal: vi.fn() };
  const binding = observeCastPlayer(framework, { getCurrentSession: () => session }, "https://nas.test/video.mp4", callbacks);
  return { player, listeners, callbacks, binding, change: () => listeners.forEach((listener) => listener()), setContent: (url: string) => { contentId = url; } };
}

describe("cast session lifecycle", () => {
  it("pauses local playback when rejoining the same video and synchronizes the TV position", () => {
    const { callbacks, player, change } = castSession();
    expect(callbacks.pauseLocal).toHaveBeenCalledOnce();
    expect(callbacks.update).toHaveBeenLastCalledWith({ time: 42, duration: 100, paused: false, device: "Living room" });
    player.currentTime = 65; change();
    expect(callbacks.update).toHaveBeenLastCalledWith(expect.objectContaining({ time: 65 }));
    expect(callbacks.pauseLocal).toHaveBeenCalledOnce();
  });

  it("resumes locally at the last TV position once the session disconnects", () => {
    const { callbacks, player, change } = castSession();
    player.currentTime = 65; player.isPaused = true; change();
    player.isConnected = false; player.currentTime = 0; change(); change();
    expect(callbacks.resumeLocal).toHaveBeenCalledExactlyOnceWith(65, false);
    expect(callbacks.update).toHaveBeenLastCalledWith(undefined);
  });

  it("does not take over a different video's casting session", () => {
    const { callbacks, player, change } = castSession("https://nas.test/other.mp4");
    player.isConnected = false; change();
    expect(callbacks.pauseLocal).not.toHaveBeenCalled();
    expect(callbacks.update).not.toHaveBeenCalled();
    expect(callbacks.resumeLocal).not.toHaveBeenCalled();
  });

  it("does not resume the wrong video after another sender replaces the TV media", () => {
    const { callbacks, player, change, setContent } = castSession();
    setContent("https://nas.test/other.mp4"); change();
    expect(callbacks.update).toHaveBeenLastCalledWith(undefined);
    player.isConnected = false; change();
    expect(callbacks.resumeLocal).not.toHaveBeenCalled();
  });

  it("unsubscribes when the viewer leaves so old sessions cannot restart a later video", () => {
    const { callbacks, player, change, binding, listeners } = castSession();
    binding.dispose();
    expect(listeners.size).toBe(0);
    player.isConnected = false; change();
    expect(callbacks.resumeLocal).not.toHaveBeenCalled();
  });
});
