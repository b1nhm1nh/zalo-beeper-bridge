// ZaloClient control-plane rate-limit routing (react/undo/sendSeen/typing),
// send-time onBeforeSend ordering, logout-during-wait safety, and the undo →
// recall event normalization. api/rate limiter are stubbed/injected.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { API } from "zca-js";
import { ZaloClient, type ZaloRecallEvent } from "../zalo-client.ts";
import type { RateLimiter } from "../rate-limiter.ts";

type FakeLimiter = { acquire: ReturnType<typeof vi.fn> };

function fakeLimiter(): FakeLimiter {
  return { acquire: vi.fn(async () => {}) };
}

function stubApi() {
  const listener = new EventEmitter() as EventEmitter & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  listener.start = vi.fn();
  listener.stop = vi.fn();
  return {
    api: {
      listener,
      getOwnId: vi.fn(() => "selfuid"),
      sendMessage: vi.fn(async () => ({ message: { msgId: "m1" } })),
      addReaction: vi.fn(async () => ({})),
      undo: vi.fn(async () => ({})),
      sendSeenEvent: vi.fn(async () => ({})),
      sendTypingEvent: vi.fn(async () => ({})),
    } as unknown as API,
    listener,
  };
}

function setApi(client: ZaloClient, api: API | null): void {
  (client as unknown as { api: API | null }).api = api;
}

function makeClient(opts: Partial<ConstructorParameters<typeof ZaloClient>[0]> = {}): { client: ZaloClient; limiter: FakeLimiter } {
  const limiter = fakeLimiter();
  const client = new ZaloClient({
    credsPath: "/tmp/unused-creds.json",
    messagesPerMinute: 6000,
    ...opts,
    // AFTER the spread so an explicitly injected limiter isn't clobbered
    rateLimiter: (opts.rateLimiter as RateLimiter | undefined) ?? (limiter as unknown as RateLimiter),
  });
  return { client, limiter };
}

describe("ZaloClient control-plane rate limiting", () => {
  it("routes react, recall, sendSeen and typing through the rate limiter", async () => {
    const { client, limiter } = makeClient();
    const { api } = stubApi();
    setApi(client, api);

    await client.react("t1", "user", "m1", "c1", ":-)");
    await client.recall("t1", "user", "m1", "c1");
    await client.sendSeen("t1", "user", "m1", "c1", "peer", "webchat");
    await client.sendTypingToZalo("t1", "user");

    expect(limiter.acquire).toHaveBeenCalledTimes(4);
    expect(api.addReaction).toHaveBeenCalledTimes(1);
    expect(api.undo).toHaveBeenCalledTimes(1);
    expect(api.sendSeenEvent).toHaveBeenCalledTimes(1);
    expect(api.sendTypingEvent).toHaveBeenCalledTimes(1);
  });

  it("does not call the limiter when not logged in", async () => {
    const { client, limiter } = makeClient();
    await expect(client.sendText("t1", "user", "hi")).rejects.toThrow("Not logged in");
    await expect(client.react("t1", "user", "m1", "c1", ":-)")).rejects.toThrow("Not logged in");
    await expect(client.recall("t1", "user", "m1", "c1")).rejects.toThrow("Not logged in");
    await client.sendSeen("t1", "user", "m1", "c1", "peer", "webchat"); // best-effort: silent no-op
    await client.sendTypingToZalo("t1", "user");
    expect(limiter.acquire).not.toHaveBeenCalled();
  });

  it("aborts a send when logout happens during the rate-limit wait", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = makeClient({ rateLimiter: { acquire: vi.fn(() => gate) } as unknown as RateLimiter });
    const { api } = stubApi();
    setApi(client, api);

    const pending = client.sendText("t1", "user", "hello").catch((err: Error) => err);
    const pendingImage = client.sendImage("t1", "user", Buffer.from("x"), "a.png", 1, 1).catch((err: Error) => err);
    const pendingSeen = client.sendSeen("t1", "user", "m1", "c1", "peer", "webchat");

    setApi(client, null); // logout mid-wait
    release();
    const textErr = await pending;
    const imageErr = await pendingImage;
    await pendingSeen;

    expect((textErr as Error).message).toBe("Not logged in");
    expect((imageErr as Error).message).toBe("Not logged in");
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendSeenEvent).not.toHaveBeenCalled();
  });

  it("fires onBeforeSend only after the rate-limit wait, right before the network call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = makeClient({ rateLimiter: { acquire: vi.fn(() => gate) } as unknown as RateLimiter });
    const { api } = stubApi();
    setApi(client, api);
    const onBeforeSend = vi.fn();

    const pending = client.sendText("t1", "user", "hello", undefined, onBeforeSend);
    await Promise.resolve(); // let the queued acquire settle
    expect(onBeforeSend).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();

    release();
    await pending;
    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("fires onBeforeSend after the wait for image sends too", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = makeClient({ rateLimiter: { acquire: vi.fn(() => gate) } as unknown as RateLimiter });
    const { api } = stubApi();
    setApi(client, api);
    const onBeforeSend = vi.fn();

    const pending = client.sendImage("t1", "user", Buffer.from("x"), "a.png", 1, 1, "cap", onBeforeSend);
    await Promise.resolve();
    expect(onBeforeSend).not.toHaveBeenCalled();

    release();
    const ids = await pending;
    expect(ids).toEqual(["m1"]);
    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("ZaloClient undo (recall) normalization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function startWithUndo(opts: Partial<ConstructorParameters<typeof ZaloClient>[0]> = {}) {
    const { client, limiter } = makeClient(opts);
    const { api, listener } = stubApi();
    setApi(client, api);
    client.startListening();
    return { client, listener, limiter };
  }

  it("normalizes a user-thread undo from a peer into a recall event", () => {
    const onRecall = vi.fn();
    const { client, listener } = startWithUndo({ onRecall });
    const emitted: ZaloRecallEvent[] = [];
    client.on("recall", (e) => emitted.push(e));

    // Shape after zca-js Undo construction (uidFrom/idTo already resolved)
    listener.emit("undo", {
      threadId: "peer1",
      isGroup: false,
      isSelf: false,
      data: { msgId: "100", cliMsgId: "200", uidFrom: "peer1", idTo: "selfuid", content: { deleteMsg: 100, cliMsgId: 200, globalMsgId: 42 } },
    });

    expect(onRecall).toHaveBeenCalledTimes(1);
    expect(onRecall).toHaveBeenCalledWith({
      threadId: "peer1",
      threadType: "user",
      msgId: "100",
      cliMsgId: "200",
      isSelf: false,
      actorId: "peer1",
    });
    expect(emitted).toEqual(onRecall.mock.calls.map((c) => c[0]));
  });

  it("normalizes a self group-thread undo (own recall from any device)", () => {
    const onRecall = vi.fn();
    const { listener } = startWithUndo({ onRecall });

    listener.emit("undo", {
      threadId: "grid1",
      isGroup: true,
      isSelf: true,
      data: { msgId: "300", cliMsgId: "400", uidFrom: "selfuid", idTo: "grid1", content: { deleteMsg: 300, cliMsgId: 400 } },
    });

    expect(onRecall).toHaveBeenCalledWith({
      threadId: "grid1",
      threadType: "group",
      msgId: "300",
      cliMsgId: "400",
      isSelf: true,
      actorId: "selfuid",
    });
  });

  it("falls back to data.msgId when content.deleteMsg is absent", () => {
    const onRecall = vi.fn();
    const { listener } = startWithUndo({ onRecall });

    listener.emit("undo", {
      threadId: "peer2",
      isGroup: false,
      isSelf: false,
      data: { msgId: "777", cliMsgId: "888", uidFrom: "peer2", content: {} },
    });

    expect(onRecall).toHaveBeenCalledWith(expect.objectContaining({ msgId: "777", cliMsgId: "888" }));
  });

  it("ignores malformed undo payloads", () => {
    const onRecall = vi.fn();
    const { client, listener } = startWithUndo({ onRecall });
    const emitted: unknown[] = [];
    client.on("recall", (e) => emitted.push(e));

    listener.emit("undo", { data: {} });
    listener.emit("undo", { threadId: "t", isGroup: false, data: {} }); // no msgId anywhere

    expect(onRecall).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });
});
