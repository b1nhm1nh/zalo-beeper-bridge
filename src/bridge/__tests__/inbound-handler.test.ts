// InboundHandler against a REAL SQLite store + mocked Matrix side — verifies the
// direction recorded per message (own phone messages = outbound) and the
// msgId-exact echo suppression end to end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "matrix-appservice-bridge";
import { EchoSuppressor } from "../echo-suppressor.ts";
import { InboundHandler } from "../inbound-handler.ts";
import type { InboundHandlerDeps } from "../inbound-handler.ts";
import { MappingStore } from "../mapping-store.ts";
import type { PuppetRegistry } from "../puppet-registry.ts";
import type { ZaloMessage } from "../../zalo/types.ts";

const OWNER = "@owner:beeper.local";
const OWN_UID = "999";
const ROOM = "!room:x";

function makeDeps(store: MappingStore): InboundHandlerDeps & { portals: { getOrCreatePortal: ReturnType<typeof vi.fn> } } {
  let n = 0;
  const intent = {
    opts: { registered: false },
    sendMessage: vi.fn(async () => ({ event_id: `$ev-${++n}` })),
  };
  const bridge = { getIntent: vi.fn(() => intent) } as unknown as Bridge;
  const portals = {
    getOrCreatePortal: vi.fn(async () => ({ room_id: ROOM, thread_id: "t1", thread_type: "user", name: null })),
    ensureGhostInRoom: vi.fn(async () => undefined),
  };
  const puppets = {
    intentFor: vi.fn(() => intent),
    ensurePuppet: vi.fn(async () => intent),
    mxidFor: (uid: string) => `@sh-zalo_${uid}:beeper.local`,
  } as unknown as PuppetRegistry;
  return {
    bridge,
    store,
    puppets,
    portals: portals as unknown as InboundHandlerDeps["portals"] & { getOrCreatePortal: ReturnType<typeof vi.fn> },
    echo: new EchoSuppressor(),
    ownerUserId: OWNER,
    mediaMaxBytes: 10_000_000,
    resolveGroupName: async () => null,
    resolveStickerUrl: async () => null,
    getOwnZaloId: () => OWN_UID,
    bridgedEventIds: new Set<string>(),
  };
}

function selfText(msgId: string, text: string): ZaloMessage {
  return {
    msgId,
    threadId: "t1",
    threadType: "user",
    senderId: OWN_UID,
    timestamp: Date.now(),
    isSelf: true,
    content: { kind: "text", text },
  };
}

function peerText(msgId: string, text: string): ZaloMessage {
  return { ...selfText(msgId, text), isSelf: false, senderId: "u-peer", senderName: "Peer" };
}

let dir: string;
let store: MappingStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-test-"));
  store = new MappingStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("InboundHandler direction recording", () => {
  it("records the owner's own phone-mirrored message as OUTBOUND", async () => {
    const deps = makeDeps(store);
    new InboundHandler(deps).handle(selfText("m-phone1", "typed on the phone"));
    await vi.waitFor(() => expect(store.hasMessage("m-phone1")).toBe(true));

    const eventId = store.getEventByZaloMsgId("m-phone1")?.eventId;
    expect(eventId).toBe("$ev-1");
    expect(store.getZaloTargetByEventId(eventId!)?.direction).toBe("outbound");
    // outbound messages must never become seen targets (owner receipt to self is bogus)
    expect(store.getSeenTargetByEventId(eventId!)).toBeNull();
  });

  it("records a peer's message as INBOUND", async () => {
    const deps = makeDeps(store);
    new InboundHandler(deps).handle(peerText("m-peer1", "hello"));
    await vi.waitFor(() => expect(store.hasMessage("m-peer1")).toBe(true));

    const eventId = store.getEventByZaloMsgId("m-peer1")?.eventId;
    const target = store.getSeenTargetByEventId(eventId!);
    expect(target?.senderId).toBe("u-peer");
  });
});

describe("InboundHandler echo suppression", () => {
  it("suppresses the selfListen echo when the armed marker's msgId matches", async () => {
    const deps = makeDeps(store);
    const handler = new InboundHandler(deps);
    deps.echo.expect("t1", "ok", { msgId: "m-send1" });

    handler.handle(selfText("m-send1", "ok"));
    await vi.waitFor(() => expect(store.hasMessage("m-send1")).toBe(true));

    // dropped before the Matrix side: backfilled as outbound (cliMsgId/quote path), nothing posted
    expect(deps.portals.getOrCreatePortal).not.toHaveBeenCalled();
  });

  it("does NOT swallow a phone-typed message with the same text but a different msgId", async () => {
    const deps = makeDeps(store);
    const handler = new InboundHandler(deps);
    deps.echo.expect("t1", "ok", { msgId: "m-send1" });

    handler.handle(selfText("m-phone9", "ok")); // user typed "ok" on their phone
    await vi.waitFor(() => expect(deps.portals.getOrCreatePortal).toHaveBeenCalled());

    expect(store.hasMessage("m-phone9")).toBe(true);
    expect(store.getZaloTargetByEventId("$ev-1")?.direction).toBe("outbound");
  });

  it("still suppresses when the marker was armed blind (text fallback, fresh window)", async () => {
    const deps = makeDeps(store);
    const handler = new InboundHandler(deps);
    deps.echo.expect("t1", "ok"); // no msgId known at arm time

    handler.handle(selfText("m-send2", "ok"));
    await vi.waitFor(() => expect(store.hasMessage("m-send2")).toBe(true));

    expect(deps.portals.getOrCreatePortal).not.toHaveBeenCalled();
  });
});
