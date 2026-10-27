import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { Catalog } from "./catalog.js";
import { LibraryDatabase } from "./library-database.js";

describe("catalog responsiveness during slow disk reads", () => {
  it.each(["readdir", "stat", "readFile"] as const)("keeps serving live segments while a scan waits for %s", async (operation) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-catalog-responsive-"));
    const media = path.join(root, "media"); const data = path.join(root, "data");
    fs.mkdirSync(media);
    fs.writeFileSync(path.join(media, "video.mp4"), "video");
    fs.writeFileSync(path.join(media, "video.info.json"), JSON.stringify({ title: "Video" }));
    const db = new LibraryDatabase(data);
    const catalog = new Catalog(db, media, data, false);
    const app = Fastify();
    app.get("/live-segment.ts", async () => "live segment");
    let markEntered!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const original = fs.promises[operation];
    const spy = vi.spyOn(fs.promises, operation).mockImplementation((async (...args: any[]) => {
      markEntered(); await released;
      return (original as any)(...args);
    }) as any);
    const scan = catalog.scan();
    try {
      await Promise.race([entered, scan.then(() => { throw new Error("Scan completed without yielding for disk I/O"); })]);
      expect(catalog.status.running).toBe(true);
      const response = await app.inject({ method: "GET", url: "/live-segment.ts" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("live segment");
      expect(catalog.status.running).toBe(true);
      release();
      expect((await scan).indexed).toBe(1);
    } finally {
      release(); await scan;
      spy.mockRestore(); await app.close(); db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
