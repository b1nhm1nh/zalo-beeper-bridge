// Owner auto-join failure handling: a failed join must be retried on a later portal
// use after the backoff window (a process-lifetime failure cache silently dropped the
// owner's own phone messages in that room forever).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "matrix-appservice-bridge";
import { OWNER_JOIN_RETRY_MS, PortalManager } from "../portal-manager.ts";
import { MappingStore } from "../mapping-store.ts";
import { PuppetRegistry } from "../puppet-registry.ts";

const OWNER = "@owner:beeper.com";
const BRANDING = { name: "Zalo", logoPath: "assets/zalo-logo.png", networkId: "zalo", stateKey: "beeper.local/sh-zalo" };

function mockBridge(ownerJoinError?: Error) {
  const intent = {
    createRoom: vi.fn(async () => ({ room_id: "!new:x" })),
    ensureRegistered: vi.fn(async () => undefined),
    setDisplayName: vi.fn(async () => undefined),
    setAvatarUrl: vi.fn(async () => undefined),
    join: ownerJoinError
      ? vi.fn(async () => {
          throw ownerJoinError;
        })
      : vi.fn(async () => undefined),
    invite: vi.fn(async () => undefined),
    uploadContent: vi.fn(async () => "mxc://x"),
    sendStateEvent: vi.fn(async () => ({ event_id: "$s" })),
    userId: "@sh-zalobot:beeper.local",
  };
  const bridge = {
    getIntent: vi.fn(() => intent),
    getBot: vi.fn(() => ({ getUserId: () => "@sh-zalobot:beeper.local" })),
  } as unknown as Bridge;
  return { bridge, intent };
}

let dir: string;
let store: MappingStore;

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-join-test-"));
  store = new MappingStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("PortalManager owner auto-join retry", () => {
  it("retries a failed owner join on the NEXT portal use after the backoff window", async () => {
    store.insertPortal({ thread_id: "t1", thread_type: "user", room_id: "!room:x", name: "Alice" });
    const { bridge, intent } = mockBridge(new Error("not invited yet"));
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, "beeper.local"), OWNER, BRANDING);

    await portals.getOrCreatePortal({ threadId: "t1", threadType: "user", senderId: "u1" });
    expect(intent.join).toHaveBeenCalledTimes(1); // failed attempt recorded

    // a message arriving while still backing off must NOT retry
    await portals.getOrCreatePortal({ threadId: "t1", threadType: "user", senderId: "u1" });
    expect(intent.join).toHaveBeenCalledTimes(1);

    // after the backoff window the next portal use retries
    vi.advanceTimersByTime(OWNER_JOIN_RETRY_MS + 1);
    await portals.getOrCreatePortal({ threadId: "t1", threadType: "user", senderId: "u1" });
    expect(intent.join).toHaveBeenCalledTimes(2);
  });

  it("stops retrying once the join succeeds", async () => {
    store.insertPortal({ thread_id: "t1", thread_type: "user", room_id: "!room:x", name: "Alice" });
    const { bridge, intent } = mockBridge();
    const portals = new PortalManager(bridge, store, new PuppetRegistry(bridge, store, "beeper.local"), OWNER, BRANDING);

    await portals.getOrCreatePortal({ threadId: "t1", threadType: "user", senderId: "u1" });
    await portals.getOrCreatePortal({ threadId: "t1", threadType: "user", senderId: "u1" });
    expect(intent.join).toHaveBeenCalledTimes(1);
  });
});
