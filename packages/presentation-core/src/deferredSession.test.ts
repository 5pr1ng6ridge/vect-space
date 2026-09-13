// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { DeferredSession } from "./deferredSession";

interface Session {
  id: number;
  disposed: boolean;
}

function createLifecycle(
  options: {
    failFirst?: boolean;
  } = {},
): {
  lifecycle: DeferredSession<Session>;
  created: Session[];
  pending: (() => void)[];
  flush(): Promise<void>;
} {
  let nextId = 1;
  const created: Session[] = [];
  const pending: (() => void)[] = [];
  const lifecycle = new DeferredSession<Session>({
    schedule: (callback) => {
      pending.push(callback);
      return () => {
        const index = pending.indexOf(callback);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    create: () => {
      const session: Session = { id: nextId, disposed: false };
      nextId += 1;
      created.push(session);
      const initialized =
        options.failFirst === true && created.length === 1
          ? Promise.reject(new Error("初始化失败"))
          : Promise.resolve();
      return { session, initialized };
    },
    dispose: (session) => {
      session.disposed = true;
    },
  });
  return {
    lifecycle,
    created,
    pending,
    flush: async () => {
      const callbacks = [...pending];
      pending.length = 0;
      for (const callback of callbacks) callback();
      // Disposal waits for initialization to settle.
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    },
  };
}

describe("DeferredSession", () => {
  it("creates on first acquire and reuses the session for later holders", () => {
    const { lifecycle, created } = createLifecycle();
    const first = lifecycle.acquire();
    const second = lifecycle.acquire();
    expect(first.session).toBe(second.session);
    expect(created).toHaveLength(1);
    expect(lifecycle.availabilities).toBe(2);
  });

  it("reclaims the same session when a release is followed by an acquire", async () => {
    const { lifecycle, created, flush } = createLifecycle();
    const first = lifecycle.acquire();
    lifecycle.release();
    // React Strict Mode's probe: cleanup then immediate re-setup.
    const second = lifecycle.acquire();
    await flush();
    expect(second.session).toBe(first.session);
    expect(created).toHaveLength(1);
    expect(first.session.disposed).toBe(false);
  });

  it("disposes one task after the last release", async () => {
    const { lifecycle, created, flush } = createLifecycle();
    const handle = lifecycle.acquire();
    lifecycle.release();
    expect(handle.session.disposed).toBe(false);
    await flush();
    expect(handle.session.disposed).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("survives 30 mount switches with exactly one session", async () => {
    const { lifecycle, created, flush } = createLifecycle();
    for (let index = 0; index < 30; index += 1) {
      const handle = lifecycle.acquire();
      expect(handle.session).toBe(created[0]);
      lifecycle.release();
    }
    // Exactly one session was created across all switches.
    expect(created).toHaveLength(1);
    await flush();
    expect(created[0]?.disposed).toBe(true);
  });

  it("drops a session whose initialization failed without disposing it", async () => {
    const { lifecycle, created, flush } = createLifecycle({ failFirst: true });
    const handle = lifecycle.acquire();
    await expect(handle.initialized).rejects.toThrow("初始化失败");
    await flush();
    expect(lifecycle.peek()).toBeNull();
    const next = lifecycle.acquire();
    expect(next.session).not.toBe(created[0]);
    expect(created[0]?.disposed).toBe(false);
  });

  it("disposes immediately when a host unmounts for good", async () => {
    const { lifecycle } = createLifecycle();
    const handle = lifecycle.acquire();
    lifecycle.disposeNow();
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.session.disposed).toBe(true);
    expect(lifecycle.peek()).toBeNull();
    lifecycle.disposeNow();
    expect(handle.session.disposed).toBe(true);
  });

  it("waits for initialization before disposing", async () => {
    let resolveInit: (() => void) | null = null;
    const session: Session = { id: 1, disposed: false };
    const lifecycle = new DeferredSession<Session>({
      schedule: (callback) => {
        callback();
        return () => undefined;
      },
      create: () => ({
        session,
        initialized: new Promise<void>((resolve) => {
          resolveInit = resolve;
        }),
      }),
      dispose: (value) => {
        value.disposed = true;
      },
    });
    lifecycle.acquire();
    lifecycle.release();
    await Promise.resolve();
    expect(session.disposed).toBe(false);
    resolveInit?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.disposed).toBe(true);
  });
});
