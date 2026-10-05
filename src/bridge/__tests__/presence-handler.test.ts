// PresenceHandler against a REAL SQLite store + mocked puppets/zalo client —
// covers receipt iteration (no early return), bogus self-seen skip, and the
// inbound reaction dedupe (replace, don't stack).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "matrix-appservice-bridge";
import { Reactions } from "zca-js";
import { MappingStore } from "../mapping-store.ts";
import { PresenceHandler } from "../presence-handler.ts";
import type { PuppetRegistry } from "../puppet-registry.ts";
import type { ZaloClient } from "../../zalo/zalo-client.ts";
import type { ZaloReactionEvent } from "../../zalo/types.ts";

const OWNER = "@owner:beeper.local";
const OWN_ZALO_UID = "999";
const ROOM = "!room:x";

function mockIntent() {
  let n = 0;
  return {
    sendReadReceipt: vi.fn(async () => undefined),
    sendTyping: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => ({ event_id: `$reaction-${++n}` })),
    matrixClient: { redactEvent: vi.fn(async () => "$redacted") },
  };
}

type MockIntent = ReturnType<typeof mockIntent>;

function makeHandler(store: MappingStore) {
  const intent = mockIntent();
  const puppets = {
    intentFor: vi.fn(() => intent as unknown as Intent),
    ensurePuppet: vi.fn(async () => intent as unknown as Intent),
    mxidFor: (uid: string) => `@sh-zalo_${uid}:beeper.local`,
  } as unknown as PuppetRegistry;
  const zalo = {
    sendSeen: vi.fn(async () => undefined),
    sendTypingToZalo: vi.fn(async () => undefined),
  } as unknown as ZaloClient;
  const handler = new PresenceHandler(store, puppets, zalo, OWNER, () => OWN_ZALO_UID);
  return { handler, intent: intent as unknown as MockIntent, zalo };
}

function reaction(partial: Partial<ZaloReactionEvent>): ZaloReactionEvent {
  return { threadId: "t1", threadType: "user", senderId: "u1", isSelf: false, targetMsgId: "z1", icon: Reactions.HEART, ...partial };
}

let dir: string;
let store: MappingStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "presence-test-"));
  store = new MappingStore(path.join(dir, "test.db"));
  store.insertPortal({ thread_id: "t1", thread_type: "user", room_id: ROOM, name: "Bob" });
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("PresenceHandler.handleOwnerReceipt", () => {
  it("sends seen for a read entry that maps, even after an unmapped one", async () => {
    store.recordMessage("z1", ROOM, "$ev1", "inbound", null, "cli1", "u-peer", "webchat");
    const { handler, zalo } = makeHandler(store);

    await handler.handleOwnerReceipt(ROOM, {
      "$gone": { "m.read": { [OWNER]: 1 } }, // not bridged — must not block the next entry
      "$ev1": { "m.read": { [OWNER]: 2 } },
    });

    expect(zalo.sendSeen).toHaveBeenCalledOnce();
    expect(zalo.sendSeen).toHaveBeenCalledWith("t1", "user", "z1", "cli1", "u-peer", "webchat");
  });

  it("does not stop at an unmapped entry that comes LAST (no early return on a miss)", async () => {
    store.recordMessage("z1", ROOM, "$ev1", "inbound", null, "cli1", "u-peer", "webchat");
    const { handler, zalo } = makeHandler(store);

    await handler.handleOwnerReceipt(ROOM, {
      "$ev1": { "m.read": { [OWNER]: 1 } },
      "$gone": { "m.read": { [OWNER]: 2 } }, // later but unmapped — earlier valid target still sent
    });

    expect(zalo.sendSeen).toHaveBeenCalledWith("t1", "user", "z1", "cli1", "u-peer", "webchat");
  });

  it("sends seen for the LATEST read entry when several map", async () => {
    store.recordMessage("z1", ROOM, "$ev1", "inbound", null, "cli1", "u-peer", "webchat");
    store.recordMessage("z2", ROOM, "$ev2", "inbound", null, "cli2", "u-peer", "webchat");
    const { handler, zalo } = makeHandler(store);

    await handler.handleOwnerReceipt(ROOM, {
      "$ev1": { "m.read": { [OWNER]: 1 } },
      "$ev2": { "m.read": { [OWNER]: 2 } },
    });

    expect(zalo.sendSeen).toHaveBeenCalledOnce();
    expect(zalo.sendSeen).toHaveBeenCalledWith("t1", "user", "z2", "cli2", "u-peer", "webchat");
  });

  it("skips the owner's own phone-mirrored messages (bogus uidFrom == uidTo seen)", async () => {
    store.recordMessage("zown", ROOM, "$evown", "inbound", null, "cliown", OWN_ZALO_UID, "webchat");
    const { handler, zalo } = makeHandler(store);

    await handler.handleOwnerReceipt(ROOM, { $evown: { "m.read": { [OWNER]: 1 } } });

    expect(zalo.sendSeen).not.toHaveBeenCalled();
  });

  it("still sends for a peer message sharing the receipt batch with an own message", async () => {
    store.recordMessage("zown", ROOM, "$evown", "inbound", null, "cliown", OWN_ZALO_UID, "webchat");
    store.recordMessage("z1", ROOM, "$ev1", "inbound", null, "cli1", "u-peer", "webchat");
    const { handler, zalo } = makeHandler(store);

    await handler.handleOwnerReceipt(ROOM, {
      $evown: { "m.read": { [OWNER]: 1 } },
      "$ev1": { "m.read": { [OWNER]: 2 } },
    });

    expect(zalo.sendSeen).toHaveBeenCalledWith("t1", "user", "z1", "cli1", "u-peer", "webchat");
  });

  it("ignores receipt batches without a read by the owner", async () => {
    store.recordMessage("z1", ROOM, "$ev1", "inbound", null, "cli1", "u-peer", "webchat");
    const { handler, zalo } = makeHandler(store);

    await handler.handleOwnerReceipt(ROOM, { "$ev1": { "m.read": { "@other:beeper.local": 1 } } });

    expect(zalo.sendSeen).not.toHaveBeenCalled();
  });
});

describe("PresenceHandler.handleReaction dedupe", () => {
  beforeEach(() => {
    store.recordMessage("z1", ROOM, "$target1", "inbound", null, "clic1", "u-peer", "webchat");
    store.recordMessage("z2", ROOM, "$target2", "inbound", null, "clic2", "u-peer", "webchat");
  });

  it("posts the first reaction without redacting", async () => {
    const { handler, intent } = makeHandler(store);

    await handler.handleReaction(reaction({}));

    expect(intent.sendEvent).toHaveBeenCalledOnce();
    expect(intent.sendEvent).toHaveBeenCalledWith(ROOM, "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", event_id: "$target1", key: "❤️" },
    });
    expect(intent.matrixClient.redactEvent).not.toHaveBeenCalled();
  });

  it("does NOT repost an unchanged reaction", async () => {
    const { handler, intent } = makeHandler(store);
    await handler.handleReaction(reaction({}));
    await handler.handleReaction(reaction({ senderName: "same again" }));

    expect(intent.sendEvent).toHaveBeenCalledOnce();
    expect(intent.matrixClient.redactEvent).not.toHaveBeenCalled();
  });

  it("REPLACES a changed reaction: redacts the old annotation, posts the new one", async () => {
    const { handler, intent } = makeHandler(store);
    await handler.handleReaction(reaction({}));
    await handler.handleReaction(reaction({ icon: Reactions.LIKE }));

    expect(intent.matrixClient.redactEvent).toHaveBeenCalledOnce();
    expect(intent.matrixClient.redactEvent).toHaveBeenCalledWith(ROOM, "$reaction-1");
    expect(intent.sendEvent).toHaveBeenCalledTimes(2);
    expect(intent.sendEvent).toHaveBeenLastCalledWith(ROOM, "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", event_id: "$target1", key: "👍" },
    });
  });

  it("redacts the LATEST annotation on a second change", async () => {
    const { handler, intent } = makeHandler(store);
    await handler.handleReaction(reaction({}));
    await handler.handleReaction(reaction({ icon: Reactions.LIKE }));
    await handler.handleReaction(reaction({ icon: Reactions.BIG_LAUGH }));

    expect(intent.matrixClient.redactEvent).toHaveBeenLastCalledWith(ROOM, "$reaction-2");
  });

  it("tracks (room, sender, target) triples independently", async () => {
    const { handler, intent } = makeHandler(store);
    await handler.handleReaction(reaction({ targetMsgId: "z1" }));
    await handler.handleReaction(reaction({ targetMsgId: "z2", icon: Reactions.LIKE }));

    expect(intent.sendEvent).toHaveBeenCalledTimes(2);
    expect(intent.matrixClient.redactEvent).not.toHaveBeenCalled();
  });

  it("still posts the new reaction when the redaction fails", async () => {
    const { handler, intent } = makeHandler(store);
    await handler.handleReaction(reaction({}));
    vi.mocked(intent.matrixClient.redactEvent).mockRejectedValueOnce(new Error("power level"));
    await handler.handleReaction(reaction({ icon: Reactions.LIKE }));

    expect(intent.sendEvent).toHaveBeenCalledTimes(2);
  });
});
