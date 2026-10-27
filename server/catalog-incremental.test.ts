import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "./catalog.js";
import { LibraryDatabase } from "./library-database.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) dispose(); });

function fixture(eager = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-incremental-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = path.join(root, "media"); fs.mkdirSync(media);
  const db = new LibraryDatabase(path.join(root, "data")); cleanup.push(() => db.close());
  const metadata = new Map<string, Record<string, unknown>>();
  const stored = vi.fn((file: string) => metadata.get(file) ?? {});
  const catalog = new Catalog(db, media, path.join(root, "data"), eager, stored);
  const add = (name: string, bytes = "video") => { const file = path.join(media, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const changes = () => Number((db.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  return { root, media, db, catalog, metadata, stored, add, changes };
}

describe("targeted library indexing", () => {
  it("adds a completed file without walking existing media or starting a full scan", async () => {
    const { db, catalog, stored, add } = fixture();
    add("old.mp4"); await catalog.scan();
    const old = db.listMedia().items[0]; db.setFavorite(old.id, true); db.updateProgress(old.id, 30, 120);
    const status = { ...catalog.status };
    add("Creator/source/new.mp4"); stored.mockClear();
    const walk = vi.spyOn(fs.promises, "readdir");
    const id = await catalog.indexStoredMedia("Creator/source/new.mp4");
    expect(walk).not.toHaveBeenCalled();
    expect(stored).toHaveBeenCalledExactlyOnceWith("Creator/source/new.mp4");
    expect(db.getMedia(id!)).toMatchObject({ relativePath: "Creator/source/new.mp4", performer: "Creator", source: "source" });
    expect(db.getMedia(old.id)).toMatchObject({ favorite: true, progressSeconds: 30 });
    expect(catalog.status).toEqual(status);
  });

  it("leaves unchanged catalog rows and thumbnails untouched during reconciliation", async () => {
    const { catalog, add, changes } = fixture(true);
    const thumbnail = vi.spyOn(catalog, "thumbnail").mockResolvedValue("cached.jpg");
    add("one.mp4"); add("two.jpg"); await catalog.scan();
    const before = changes();
    const stat = vi.spyOn(fs.promises, "stat");
    await catalog.scan();
    expect(changes()).toBe(before);
    expect(thumbnail).toHaveBeenCalledTimes(2);
    expect(stat.mock.calls.some(([file]) => String(file).endsWith(".json"))).toBe(false);
  });

  it("still refreshes changed metadata while preserving favorites and playback", async () => {
    const { db, catalog, metadata, add } = fixture();
    add("one.mp4"); add("one.info.json", JSON.stringify({ upload_date: "20240101" }));
    await catalog.scan();
    const item = db.listMedia().items[0]; db.setFavorite(item.id, true); db.updateProgress(item.id, 20, 120);
    metadata.set("one.mp4", { title: "Updated title" });
    add("one.info.json", JSON.stringify({ upload_date: "20250203" }));
    await catalog.scan();
    expect(db.getMedia(item.id)).toMatchObject({ title: "Updated title", mediaDate: "2025-02-03T00:00:00.000Z", favorite: true, progressSeconds: 20 });
  });

  it("indexes a replacement and retires only the old path", async () => {
    const { db, catalog, add, media } = fixture();
    add("old.mp4"); add("keep.mp4"); await catalog.scan();
    const old = db.listMedia().items.find((item) => item.relativePath === "old.mp4")!;
    const kept = db.listMedia().items.find((item) => item.relativePath === "keep.mp4")!;
    fs.unlinkSync(path.join(media, "old.mp4")); add("new.mp4", "better video");
    const replacement = await catalog.indexStoredMedia("new.mp4", "old.mp4");
    expect(db.getMedia(old.id)).toBeUndefined();
    expect(db.getMedia(kept.id)).toBeDefined();
    expect(db.getMedia(replacement!)).toMatchObject({ relativePath: "new.mp4" });
    expect(db.listMedia().total).toBe(2);
  });

  it("keeps a newly indexed file visible when an already running full scan finishes", async () => {
    const { db, catalog, add } = fixture();
    const old = add("old.mp4"); await catalog.scan();
    let entered!: () => void; let release!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = fs.promises.stat;
    vi.spyOn(fs.promises, "stat").mockImplementation((async (file: fs.PathLike, ...args: any[]) => {
      if (String(file) === old) { entered(); await gate; }
      return (original as any)(file, ...args);
    }) as typeof fs.promises.stat);
    const scan = catalog.scan();
    try {
      await blocked; add("arrived.mp4");
      const id = await catalog.indexStoredMedia("arrived.mp4");
      expect(catalog.status.running).toBe(true);
      expect(db.getMedia(id!)).toBeDefined();
      release(); await scan;
      expect(db.getMedia(id!)).toBeDefined();
      expect(db.listMedia().total).toBe(2);
    } finally { release(); await scan; }
  });

  it("normalizes stored Windows paths and rejects paths outside the media root", async () => {
    const { catalog, db, add } = fixture();
    add("Creator/clip.mp4");
    const id = await catalog.indexStoredMedia("Creator\\clip.mp4");
    expect(db.getMedia(id!)).toMatchObject({ relativePath: "Creator/clip.mp4" });
    await expect(catalog.indexStoredMedia("../outside.mp4")).rejects.toThrow("escapes");
    expect(db.listMedia().total).toBe(1);
  });

  it("does not let an older in-flight read overwrite a newly replaced file at the same path", async () => {
    const { catalog, db, add } = fixture();
    const file = add("same.mp4", "old");
    let entered!: () => void; let release!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = fs.promises.stat;
    let first = true;
    vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike, ...args: any[]) => {
      const stat = await (original as any)(target, ...args);
      if (String(target) === file && first) { first = false; entered(); await gate; }
      return stat;
    }) as typeof fs.promises.stat);
    const old = catalog.indexStoredMedia("same.mp4");
    try {
      await blocked; add("same.mp4", "new and larger");
      const fresh = catalog.indexStoredMedia("same.mp4");
      release(); await old;
      const id = await fresh;
      expect(db.getMedia(id!)).toMatchObject({ size: 14 });
    } finally { release(); await old; }
  });

  it("does not resurrect an old replacement path that a full scan was already reading", async () => {
    const { catalog, db, add, media } = fixture();
    const file = add("old.mp4"); await catalog.scan();
    const old = db.listMedia().items[0];
    let entered!: () => void; let release!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = fs.promises.stat;
    vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike, ...args: any[]) => {
      const stat = await (original as any)(target, ...args);
      if (String(target) === file) { entered(); await gate; }
      return stat;
    }) as typeof fs.promises.stat);
    const scan = catalog.scan();
    try {
      await blocked; fs.unlinkSync(path.join(media, "old.mp4")); add("new.mp4");
      const replacement = catalog.indexStoredMedia("new.mp4", "old.mp4");
      await vi.waitFor(() => expect(db.listMedia().items.some((item) => item.relativePath === "new.mp4")).toBe(true));
      release(); await Promise.all([scan, replacement]);
      expect(db.getMedia(old.id)).toBeUndefined();
      expect(db.listMedia().items.map((item) => item.relativePath)).toEqual(["new.mp4"]);
    } finally { release(); await scan; }
  });
});
