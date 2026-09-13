// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { SceneTextureStore } from "./sceneTextures";
import { createMemoryTextureLoader } from "./sceneTestKit";

describe("SceneTextureStore", () => {
  it("decodes once, shares the texture and counts references", async () => {
    const loader = createMemoryTextureLoader();
    const store = new SceneTextureStore({ load: loader.load, budget: 8 });
    const first = await store.acquire("/a.png");
    const second = await store.acquire("/a.png");
    expect(first).toBe(second);
    expect(loader.loaded).toHaveLength(1);
    expect(store.refCount("/a.png")).toBe(2);

    store.release("/a.png");
    expect(store.has("/a.png")).toBe(true);
    expect(loader.destroyed).toHaveLength(0);
    store.release("/a.png");
    expect(store.has("/a.png")).toBe(false);
    expect(loader.destroyed).toHaveLength(1);
  });

  it("shares one in-flight decode between concurrent acquirers", async () => {
    let resolveLoad:
      | ((value: { width: number; height: number; destroy(): void }) => void)
      | null = null;
    const loads: string[] = [];
    const store = new SceneTextureStore({
      load: (url) => {
        loads.push(url);
        return new Promise((resolve) => {
          resolveLoad = (value) => resolve(value);
        });
      },
      budget: 4,
    });
    const first = store.acquire("/a.png");
    const second = store.acquire("/a.png");
    expect(loads).toEqual(["/a.png"]);
    resolveLoad?.({ width: 1, height: 1, destroy: () => undefined });
    expect(await first).toBe(await second);
    expect(store.refCount("/a.png")).toBe(2);
  });

  it("enforces the texture budget and frees a slot after release", async () => {
    const loader = createMemoryTextureLoader();
    const store = new SceneTextureStore({ load: loader.load, budget: 2 });
    await store.acquire("/a.png");
    await store.acquire("/b.png");
    await expect(store.acquire("/c.png")).rejects.toThrow(
      "单次会话纹理数量超过 2 个",
    );
    store.release("/a.png");
    await expect(store.acquire("/c.png")).resolves.toBeTruthy();
  });

  it("drops a failed load so it never occupies a slot and can be retried", async () => {
    const loader = createMemoryTextureLoader({}, new Set(["/broken.png"]));
    const store = new SceneTextureStore({ load: loader.load, budget: 1 });
    await expect(store.acquire("/broken.png")).rejects.toThrow("测试失败");
    expect(store.size).toBe(0);
    expect(store.refCount("/broken.png")).toBe(0);
    await expect(store.acquire("/ok.png")).resolves.toBeTruthy();
  });

  it("clears one shared failed decode for every concurrent acquirer", async () => {
    let attempts = 0;
    const texture = { width: 1, height: 1, destroy: () => undefined };
    const store = new SceneTextureStore({
      load: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("测试失败"))
          : Promise.resolve(texture);
      },
      budget: 1,
    });
    const first = store.acquire("/broken.png");
    const second = store.acquire("/broken.png");
    expect(store.refCount("/broken.png")).toBe(2);
    await expect(first).rejects.toThrow("测试失败");
    await expect(second).rejects.toThrow("测试失败");
    // Both acquirers shared one decode; the failure leaves no reference, no
    // budget slot and no poisoned promise behind for the next retry.
    expect(attempts).toBe(1);
    expect(store.has("/broken.png")).toBe(false);
    expect(store.size).toBe(0);
    expect(store.refCount("/broken.png")).toBe(0);
    await expect(store.acquire("/broken.png")).resolves.toBe(texture);
    expect(attempts).toBe(2);
    expect(store.refCount("/broken.png")).toBe(1);
    store.release("/broken.png");
    expect(store.refCount("/broken.png")).toBe(0);
  });

  it("does not delete a newer entry when an abandoned decode fails late", async () => {
    const failures: ((reason: Error) => void)[] = [];
    const texture = { width: 1, height: 1, destroy: () => undefined };
    let calls = 0;
    const store = new SceneTextureStore({
      load: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve(texture);
        return new Promise((_resolve, reject) => {
          failures.push(reject);
        });
      },
      budget: 2,
    });
    const abandoned = store.acquire("/a.png");
    // The reference is dropped while the image is still decoding, so the entry
    // is replaced by a fresh acquire of the same url.
    store.release("/a.png");
    await expect(store.acquire("/a.png")).resolves.toBe(texture);
    expect(store.texture("/a.png")).toBe(texture);
    expect(store.refCount("/a.png")).toBe(1);

    failures[0]?.(new Error("测试失败"));
    await expect(abandoned).rejects.toThrow("测试失败");
    // The stale failure must not remove the newer entry or its reference.
    expect(store.has("/a.png")).toBe(true);
    expect(store.texture("/a.png")).toBe(texture);
    expect(store.refCount("/a.png")).toBe(1);
  });

  it("retains only a resident texture", async () => {
    const loader = createMemoryTextureLoader();
    const store = new SceneTextureStore({ load: loader.load, budget: 4 });
    expect(store.retain("/a.png")).toBe(false);
    await store.acquire("/a.png");
    expect(store.retain("/a.png")).toBe(true);
    expect(store.refCount("/a.png")).toBe(2);
    // `releaseAll` drops one reference per distinct url.
    store.releaseAll(["/a.png", "/a.png"]);
    expect(store.refCount("/a.png")).toBe(1);
    store.release("/a.png");
    expect(loader.destroyed).toHaveLength(1);
  });

  it("releases every reference and destroys resident textures", async () => {
    const loader = createMemoryTextureLoader();
    const store = new SceneTextureStore({ load: loader.load, budget: 4 });
    await store.acquire("/a.png");
    await store.acquire("/b.png");
    store.destroy();
    expect(loader.destroyed.map((texture) => texture.url).sort()).toEqual([
      "/a.png",
      "/b.png",
    ]);
    await expect(store.acquire("/c.png")).rejects.toThrow("纹理缓存已释放");
  });

  it("destroys pixels that finish decoding after the last reference was released", async () => {
    let finish:
      | ((value: { width: number; height: number; destroy(): void }) => void)
      | null = null;
    const destroyed: unknown[] = [];
    const texture = {
      width: 1,
      height: 1,
      destroy: (): void => {
        destroyed.push(texture);
      },
    };
    const store = new SceneTextureStore({
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      budget: 4,
    });
    const acquired = store.acquire("/late.png");
    store.release("/late.png");
    finish?.(texture);
    await expect(acquired).resolves.toBe(texture);
    expect(destroyed).toEqual([texture]);
  });

  it("destroys pixels that finish decoding after the store was destroyed", async () => {
    let finish:
      | ((value: { width: number; height: number; destroy(): void }) => void)
      | null = null;
    const destroyed: unknown[] = [];
    const texture = {
      width: 1,
      height: 1,
      destroy: (): void => {
        destroyed.push(texture);
      },
    };
    const store = new SceneTextureStore({
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      budget: 4,
    });
    const acquired = store.acquire("/late.png");
    store.destroy();
    finish?.(texture);
    await expect(acquired).resolves.toBe(texture);
    expect(destroyed).toEqual([texture]);
  });

  it("resizes the budget for a host that declares animations", async () => {
    const loader = createMemoryTextureLoader();
    const store = new SceneTextureStore({ load: loader.load, budget: 1 });
    store.setBudget(4);
    expect(store.budget).toBe(4);
    await store.acquire("/a.png");
    await store.acquire("/b.png");
    expect(store.size).toBe(2);
  });
});
