// Media-path echo-marker lifecycle: markers must arm at real send time (after
// the rate-limit wait, via the onBeforeSend hook) and be disarmed when the send
// fails — otherwise own phone photos/captions stay suppressed (or arrive as
// duplicates when the TTL outlives a queued send).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeakEvent } from "matrix-appservice-bridge";
import { OutboundHandler, type OutboundHandlerDeps } from "../outbound-handler.ts";
import type { PortalRow } from "../mapping-store.ts";
import { downloadMatrixMedia } from "../media-handler.ts";

vi.mock("../media-handler.ts", () => ({
  downloadMatrixMedia: vi.fn(async () => ({ buffer: Buffer.from("fakepng"), mimetype: "image/png" })),
}));

const OWNER = "@owner:beeper.local";
const ROOM = "!room:beeper.local";
const PORTAL: PortalRow = { thread_id: "t1", thread_type: "user", room_id: ROOM, name: null };

function mockEcho() {
  return {
    expect: vi.fn(),
    expectImage: vi.fn(),
    cancel: vi.fn(),
    cancelImage: vi.fn(),
    consume: vi.fn(() => false),
    consumeImage: vi.fn(() => false),
  };
}

function makeDeps() {
  const echo = mockEcho();
  // Loose Mock typing: sendImage/sendFile get re-stubbed with the full
  // (threadId, …, caption, onBeforeSend) signature in several tests
  const zalo: { ownId: string } & Record<"sendText" | "sendImage" | "sendFile" | "react" | "recall", ReturnType<typeof vi.fn>> = {
    ownId: "selfuid",
    sendText: vi.fn(async () => ({ msgId: "m1" })),
    sendImage: vi.fn(async () => ["m1"]),
    sendFile: vi.fn(async () => ["m1"]),
    react: vi.fn(async () => {}),
    recall: vi.fn(async () => {}),
  };
  const store = {
    getPortalByRoom: vi.fn(() => PORTAL),
    hasEventId: vi.fn(() => false),
    recordMessage: vi.fn(),
    markOutboundHandled: vi.fn(),
    getQuoteJsonByEventId: vi.fn(() => null),
    getZaloTargetByEventId: vi.fn(() => undefined),
    getPuppetDisplayName: vi.fn(() => null),
  };
  const bridge = { getIntent: () => ({ sendMessage: vi.fn(async () => {}) }) };
  const deps = {
    bridge,
    store,
    zalo,
    echo,
    ownerUserId: OWNER,
    mediaMaxBytes: 1024,
    homeserverUrl: "https://hs",
    matrixToken: "tok",
    bridgedEventIds: new Set<string>(),
  } as unknown as OutboundHandlerDeps;
  return { deps, echo, zalo, store };
}

function mediaEvent(body: string, filename = "photo.jpg"): WeakEvent {
  return {
    type: "m.room.message",
    room_id: ROOM,
    sender: OWNER,
    event_id: "$evt1",
    content: {
      msgtype: "m.image",
      body,
      filename,
      url: "mxc://beeper.local/abc",
      info: { mimetype: "image/png" },
    },
  } as unknown as WeakEvent;
}

/** Simulates the zalo client contract: onBeforeSend fires right before the network call. */
function sendImageArmingThen(impl: (onBeforeSend?: () => void) => Promise<string[]>) {
  return vi.fn(async (_tid: string, _tt: string, _data: Buffer, _file: string, _w: number, _h: number, _caption: string, onBeforeSend?: () => void) =>
    impl(onBeforeSend),
  );
}

describe("OutboundHandler media echo markers", () => {
  beforeEach(() => {
    vi.mocked(downloadMatrixMedia).mockClear();
  });

  it("arms expectImage + caption expect via onBeforeSend at real send time, not before the rate-limit wait", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, echo, zalo } = makeDeps();
    zalo.sendImage = sendImageArmingThen(async (onBeforeSend) => {
      await gate; // rate-limit wait in flight
      onBeforeSend?.();
      return ["m1"];
    });
    const handler = new OutboundHandler(deps);

    const done = handler.handle(mediaEvent("my caption"));
    await vi.waitFor(() => expect(zalo.sendImage).toHaveBeenCalledTimes(1));
    // Send queued (limiter pending) → markers must NOT be armed yet, else the
    // 15s TTL expires before the echo arrives and the send dupes
    expect(echo.expectImage).not.toHaveBeenCalled();
    expect(echo.expect).not.toHaveBeenCalled();

    release();
    await done;
    expect(echo.expectImage).toHaveBeenCalledWith("t1");
    expect(echo.expect).toHaveBeenCalledWith("t1", "my caption");
  });

  it("cancels image and caption markers when the send fails after arming", async () => {
    const { deps, echo, zalo } = makeDeps();
    zalo.sendImage = sendImageArmingThen(async (onBeforeSend) => {
      onBeforeSend?.();
      throw new Error("Zalo 500");
    });
    const handler = new OutboundHandler(deps);

    await handler.handle(mediaEvent("my caption"));
    expect(echo.cancelImage).toHaveBeenCalledWith("t1");
    expect(echo.cancel).toHaveBeenCalledWith("t1", "my caption");
  });

  it("cancels only the image marker when the failed send had no caption", async () => {
    const { deps, echo, zalo } = makeDeps();
    zalo.sendImage = sendImageArmingThen(async (onBeforeSend) => {
      onBeforeSend?.();
      throw new Error("Zalo 500");
    });
    const handler = new OutboundHandler(deps);

    await handler.handle(mediaEvent("photo.jpg")); // body === filename → no caption
    expect(echo.cancelImage).toHaveBeenCalledWith("t1");
    expect(echo.cancel).not.toHaveBeenCalled();
  });

  it("does not cancel anything when the failure happens before arming (download failed)", async () => {
    const { deps, echo } = makeDeps();
    vi.mocked(downloadMatrixMedia).mockRejectedValueOnce(new Error("download boom"));
    const handler = new OutboundHandler(deps);

    await handler.handle(mediaEvent("my caption"));
    expect(echo.expectImage).not.toHaveBeenCalled();
    expect(echo.cancelImage).not.toHaveBeenCalled();
    expect(echo.cancel).not.toHaveBeenCalled();
  });

  it("applies the same arm-at-send-time + cancel-on-failure lifecycle to sendFile", async () => {
    const { deps, echo, zalo } = makeDeps();
    zalo.sendFile = vi.fn(
      async (_tid: string, _tt: string, _data: Buffer, _file: string, _caption: string, onBeforeSend?: () => void) => {
        onBeforeSend?.();
        throw new Error("upload aborted");
      },
    );
    const handler = new OutboundHandler(deps);

    await handler.handle({
      type: "m.room.message",
      room_id: ROOM,
      sender: OWNER,
      event_id: "$evt3",
      content: { msgtype: "m.video", body: "clip.mp4", filename: "clip.mp4", url: "mxc://beeper.local/v", info: { mimetype: "video/mp4" } },
    } as unknown as WeakEvent);
    expect(echo.expectImage).toHaveBeenCalledWith("t1"); // armed at send time
    expect(echo.expect).not.toHaveBeenCalled(); // body === filename → no caption marker
    expect(echo.cancelImage).toHaveBeenCalledWith("t1"); // then disarmed on failure
  });

  it("still cancels the text marker when a text send fails", async () => {
    const { deps, echo, zalo } = makeDeps();
    zalo.sendText.mockRejectedValueOnce(new Error("nope"));
    const handler = new OutboundHandler(deps);

    await handler.handle({
      type: "m.room.message",
      room_id: ROOM,
      sender: OWNER,
      event_id: "$evt2",
      content: { msgtype: "m.text", body: "hello" },
    } as unknown as WeakEvent);
    expect(echo.cancel).toHaveBeenCalledWith("t1", "hello");
  });
});
