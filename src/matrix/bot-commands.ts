// Management commands handled by the bridge bot (@sh-zalobot).
// Commands accepted ONLY from the configured owner (single-user bridge).
import type { Bridge, WeakEvent } from "matrix-appservice-bridge";
import type { ZaloClient } from "../zalo/zalo-client.ts";

const startedAt = Date.now();

function formatUptime(): string {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

export interface BotCommandContext {
  bridge: Bridge;
  zalo: ZaloClient;
  ownerUserId: string;
  /** Conversation sync (pinned + top groups); returns a summary message. */
  runSync?: () => Promise<string>;
}

// The login QR is a full account-takeover capability while it is on screen — it
// must not linger in room history. Track the posted QR event ids per room so they
// can be redacted once login completes (or on logout). Bounded: every long-lived
// in-process map must be, on a months-running bridge.
const MAX_TRACKED_QR_ROOMS = 100;
const postedQrMessageIds = new Map<string, string[]>();

function rememberQrMessage(roomId: string, eventId: string): void {
  const ids = [...(postedQrMessageIds.get(roomId) ?? []), eventId].slice(-MAX_TRACKED_QR_ROOMS);
  postedQrMessageIds.delete(roomId); // re-insert at newest position
  postedQrMessageIds.set(roomId, ids);
  while (postedQrMessageIds.size > MAX_TRACKED_QR_ROOMS) {
    const oldest = postedQrMessageIds.keys().next();
    if (oldest.done) break;
    postedQrMessageIds.delete(oldest.value);
  }
}

async function redactPostedQrs(ctx: BotCommandContext, roomId: string, reason: string): Promise<void> {
  const ids = postedQrMessageIds.get(roomId);
  if (!ids?.length) return;
  postedQrMessageIds.delete(roomId);
  const client = ctx.bridge.getIntent().botSdkIntent.underlyingClient;
  for (const eventId of ids) {
    try {
      await client.redactEvent(roomId, eventId, reason);
    } catch (err) {
      console.warn(`[bot] failed to redact login QR ${eventId} in ${roomId}: ${(err as Error).message}`);
    }
  }
}

/** Redact any still-posted login QRs across all rooms (used on logout). */
async function redactAllPostedQrs(ctx: BotCommandContext, reason: string): Promise<void> {
  for (const roomId of [...postedQrMessageIds.keys()]) {
    await redactPostedQrs(ctx, roomId, reason);
  }
}

/**
 * The QR grants whoever scans it full access to the Zalo account, so only post it
 * into the owner's 1:1 DM with the bot — never into a group/portal room where any
 * member (or a lurker via history) could scan it. Fails closed: if membership
 * cannot be determined, the QR is not posted anywhere.
 */
async function isOwnerDm(ctx: BotCommandContext, botUserId: string, roomId: string): Promise<boolean> {
  try {
    const members = await ctx.bridge.getIntent().botSdkIntent.underlyingClient.getJoinedRoomMembers(roomId);
    return members.length === 2 && members.includes(botUserId) && members.includes(ctx.ownerUserId);
  } catch (err) {
    console.warn(`[bot] cannot verify DM membership of ${roomId}: ${(err as Error).message}`);
    return false;
  }
}

async function handleLogin(ctx: BotCommandContext, roomId: string): Promise<void> {
  const intent = ctx.bridge.getIntent();
  if (ctx.zalo.isLoggedIn) {
    await intent.sendText(roomId, `Already logged in to Zalo (uid ${ctx.zalo.ownId}). Use 'logout' first to switch.`);
    return;
  }
  await intent.sendText(roomId, "Generating Zalo QR — scan it with the Zalo app, then confirm on your phone.");
  try {
    await ctx.zalo.loginWithQR(async (png) => {
      const mxc = await intent.uploadContent(png, { type: "image/png", name: "zalo-login-qr.png" });
      const { event_id } = await intent.sendMessage(roomId, {
        msgtype: "m.image",
        url: mxc,
        body: "zalo-login-qr.png",
        info: { mimetype: "image/png" },
      });
      if (!event_id) return;
      // Each fresh QR supersedes the previous one — redact the stale secret at once
      await redactPostedQrs(ctx, roomId, "superseded by a newer login QR");
      rememberQrMessage(roomId, event_id);
    });
    ctx.zalo.startListening();
    await redactPostedQrs(ctx, roomId, "login completed");
    await intent.sendText(roomId, `✓ Logged in to Zalo (uid ${ctx.zalo.ownId}), listener started.`);
  } catch (err) {
    await intent.sendText(roomId, `Zalo login failed: ${(err as Error).message}`);
  }
}

async function handleStatus(ctx: BotCommandContext, roomId: string): Promise<void> {
  const s = ctx.zalo.status;
  const lines = [
    `bridge uptime: ${formatUptime()}`,
    `zalo: ${s.loggedIn ? `logged in (uid ${s.ownId})` : "NOT logged in — send 'login'"}`,
    `listener: ${s.listener}`,
  ];
  await ctx.bridge.getIntent().sendText(roomId, lines.join("\n"));
}

/** Handles bot-directed events. Returns true when the event was consumed. */
export async function handleBotEvent(ctx: BotCommandContext, event: WeakEvent): Promise<boolean> {
  const botUserId = ctx.bridge.getBot().getUserId();
  if (event.sender === botUserId) return true; // ignore own echoes

  // Auto-accept invites addressed to the bot (owner starting the management DM)
  if (event.type === "m.room.member" && event.state_key === botUserId) {
    const content = event.content as { membership?: string };
    if (content.membership === "invite" && event.sender === ctx.ownerUserId) {
      await ctx.bridge.getIntent().join(event.room_id);
      await ctx.bridge.getIntent().sendText(event.room_id, "sh-zalo bridge bot ready. Commands: ping | login | logout | status | sync");
    }
    return true;
  }

  if (event.type !== "m.room.message") return false;
  if (event.sender !== ctx.ownerUserId) return false; // commands are owner-only
  const body = (event.content as { body?: string }).body?.trim().toLowerCase();

  switch (body) {
    case "ping":
      await ctx.bridge.getIntent().sendText(event.room_id, `pong! uptime ${formatUptime()}`);
      return true;
    case "login": {
      // QR secrecy: only the owner's DM may display it (command auth stays owner-only)
      if (!(await isOwnerDm(ctx, botUserId, event.room_id))) {
        await ctx.bridge.getIntent().sendText(
          event.room_id,
          "Refusing to post the login QR here — it grants full access to the Zalo account. Open this bot's direct message chat and send 'login' there.",
        );
        return true;
      }
      await handleLogin(ctx, event.room_id);
      return true;
    }
    case "logout":
      ctx.zalo.logout();
      await ctx.bridge.getIntent().sendText(event.room_id, "Logged out of Zalo; saved credentials cleared.");
      // Any login QR still in history must not outlive the session it belongs to
      await redactAllPostedQrs(ctx, "logged out");
      return true;
    case "status":
      await handleStatus(ctx, event.room_id);
      return true;
    case "sync": {
      if (!ctx.runSync || !ctx.zalo.isLoggedIn) {
        await ctx.bridge.getIntent().sendText(event.room_id, "Sync unavailable — log in to Zalo first.");
        return true;
      }
      await ctx.bridge.getIntent().sendText(event.room_id, "Syncing pinned conversations + top groups (paced to protect the account)...");
      const summary = await ctx.runSync();
      await ctx.bridge.getIntent().sendText(event.room_id, summary);
      return true;
    }
    default:
      return false;
  }
}
