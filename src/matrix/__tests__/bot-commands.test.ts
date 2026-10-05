import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { Bridge, Intent, WeakEvent } from "matrix-appservice-bridge";
import { handleBotEvent, type BotCommandContext } from "../bot-commands.ts";

const OWNER = "@owner:beeper.local";
const BOT = "@sh-zalobot:beeper.local";
const DM = "!dm:beeper.local";
const GROUP = "!group:beeper.local";

interface Ctx {
  ctx: BotCommandContext;
  intent: {
    sendText: Mock;
    sendMessage: Mock;
    uploadContent: Mock;
  };
  zalo: {
    isLoggedIn: boolean;
    ownId: string;
    loginWithQR: Mock;
    logout: Mock;
    startListening: Mock;
  };
  underlyingClient: { getJoinedRoomMembers: Mock; redactEvent: Mock };
}

/** Builds a faked bridge/zalo context whose room has the given joined members. */
function makeCtx(joinedMembers: string[] | Error): Ctx {
  const underlyingClient = {
    getJoinedRoomMembers: vi.fn(async () => {
      if (joinedMembers instanceof Error) throw joinedMembers;
      return joinedMembers;
    }),
    redactEvent: vi.fn(async () => "$redaction"),
  };
  const intent = {
    sendText: vi.fn(async () => ({})),
    sendMessage: vi.fn(async () => ({ event_id: "$qr1" })),
    sendEvent: vi.fn(async () => ({ event_id: "$e" })),
    uploadContent: vi.fn(async () => "mxc://beeper.local/qr.png"),
    join: vi.fn(async () => {}),
    botSdkIntent: { underlyingClient },
  };
  const bridge = {
    getIntent: () => intent as unknown as Intent,
    getBot: () => ({ getUserId: () => BOT }),
  } as unknown as Bridge;
  const zalo = {
    isLoggedIn: false,
    ownId: "zalo-uid",
    loginWithQR: vi.fn(async (deliver: (png: Buffer) => Promise<void>) => {
      await deliver(Buffer.from("qr-png"));
    }),
    logout: vi.fn(),
    startListening: vi.fn(),
  };
  return { ctx: { bridge, zalo, ownerUserId: OWNER } as unknown as BotCommandContext, intent, zalo, underlyingClient };
}

function command(roomId: string, body: string, sender = OWNER): WeakEvent {
  return {
    type: "m.room.message",
    sender,
    room_id: roomId,
    event_id: "$cmd",
    content: { body },
    origin_server_ts: Date.now(),
  } as unknown as WeakEvent;
}

describe("login command gating", () => {
  it("accepts 'login' in the owner's DM, posts the QR, and redacts it when login completes", async () => {
    const { ctx, intent, zalo, underlyingClient } = makeCtx([OWNER, BOT]);
    expect(await handleBotEvent(ctx, command(DM, "login"))).toBe(true);
    expect(zalo.loginWithQR).toHaveBeenCalledTimes(1);
    expect(intent.uploadContent).toHaveBeenCalledTimes(1);
    expect(intent.sendMessage).toHaveBeenCalledTimes(1);
    expect(underlyingClient.getJoinedRoomMembers).toHaveBeenCalledWith(DM);
    expect(underlyingClient.redactEvent).toHaveBeenCalledWith(DM, "$qr1", "login completed");
    expect(zalo.startListening).toHaveBeenCalled();
  });

  it("rejects 'login' in a group room and posts no QR there", async () => {
    const { ctx, intent, zalo, underlyingClient } = makeCtx([OWNER, BOT, "@friend:beeper.local"]);
    expect(await handleBotEvent(ctx, command(GROUP, "login"))).toBe(true); // consumed with a notice
    expect(zalo.loginWithQR).not.toHaveBeenCalled();
    expect(intent.sendMessage).not.toHaveBeenCalled();
    expect(intent.uploadContent).not.toHaveBeenCalled();
    expect(underlyingClient.redactEvent).not.toHaveBeenCalled();
    expect(intent.sendText).toHaveBeenCalledWith(GROUP, expect.stringMatching(/direct message/i));
  });

  it("fails closed when room membership cannot be determined", async () => {
    const { ctx, zalo } = makeCtx(new Error("membership unavailable"));
    await handleBotEvent(ctx, command(GROUP, "login"));
    expect(zalo.loginWithQR).not.toHaveBeenCalled();
  });

  it("redacts each QR as a fresh one supersedes it, then the last one on success", async () => {
    const { ctx, intent, zalo, underlyingClient } = makeCtx([OWNER, BOT]);
    (intent.sendMessage as Mock)
      .mockImplementationOnce(async () => ({ event_id: "$qr0" }))
      .mockImplementation(async () => ({ event_id: "$qr1" }));
    zalo.loginWithQR = vi.fn(async (deliver: (png: Buffer) => Promise<void>) => {
      await deliver(Buffer.from("first"));
      await deliver(Buffer.from("second"));
    });
    await handleBotEvent(ctx, command(DM, "login"));
    expect(underlyingClient.redactEvent).toHaveBeenCalledWith(DM, "$qr0", "superseded by a newer login QR");
    expect(underlyingClient.redactEvent).toHaveBeenCalledWith(DM, "$qr1", "login completed");
  });

  it("leaves the QR for logout to redact when the login fails", async () => {
    const { ctx, zalo, intent, underlyingClient } = makeCtx([OWNER, BOT]);
    zalo.loginWithQR = vi.fn(async (deliver: (png: Buffer) => Promise<void>) => {
      await deliver(Buffer.from("qr"));
      throw new Error("timed out waiting for scan");
    });
    await handleBotEvent(ctx, command(DM, "login"));
    expect(underlyingClient.redactEvent).not.toHaveBeenCalled();
    expect(intent.sendText).toHaveBeenCalledWith(DM, expect.stringContaining("login failed"));

    await handleBotEvent(ctx, command(DM, "logout"));
    expect(underlyingClient.redactEvent).toHaveBeenCalledWith(DM, "$qr1", "logged out");
  });
});

describe("other commands", () => {
  it("still answers 'ping' outside a DM — the gate is login-only", async () => {
    const { ctx, intent } = makeCtx([OWNER, BOT, "@friend:beeper.local"]);
    expect(await handleBotEvent(ctx, command(GROUP, "ping"))).toBe(true);
    expect(intent.sendText).toHaveBeenCalledWith(GROUP, expect.stringContaining("pong"));
  });

  it("ignores commands from non-owners (auth unchanged)", async () => {
    const { ctx, zalo } = makeCtx([OWNER, BOT]);
    expect(await handleBotEvent(ctx, command(DM, "login", "@stranger:beeper.local"))).toBe(false);
    expect(zalo.loginWithQR).not.toHaveBeenCalled();
  });
});
