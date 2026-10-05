// Entrypoint: load config → start Zalo client + appservice → route events.
import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { loadConfig } from "./config.ts";
import { EchoSuppressor } from "./bridge/echo-suppressor.ts";
import { InboundHandler } from "./bridge/inbound-handler.ts";
import { MappingStore } from "./bridge/mapping-store.ts";
import { OutboundHandler } from "./bridge/outbound-handler.ts";
import { PortalManager } from "./bridge/portal-manager.ts";
import { PresenceHandler } from "./bridge/presence-handler.ts";
import { assertGhostNamespace, PuppetRegistry } from "./bridge/puppet-registry.ts";
import { SyncManager } from "./bridge/sync-manager.ts";
import { createBridge, startBridge } from "./matrix/appservice.ts";
import { AVATAR_MAX_BYTES, createZaloStateMachine } from "./matrix/beeper-bridge-state.ts";
import { fetchMediaCapped } from "./bridge/media-handler.ts";
import { handleBotEvent, type BotCommandContext } from "./matrix/bot-commands.ts";
import { ensureNetworkIdentity } from "./matrix/network-branding.ts";
import { ZaloClient } from "./zalo/zalo-client.ts";

const config = loadConfig();

// launchd StandardOut/ErrPath point at logs/ — a fresh clone has none and launchd will
// not create it (the job then fails before we ever run). Derive it from the module
// location (<repo>/src → <repo>/logs) so it works regardless of the working directory.
const logsDir = path.resolve(import.meta.dirname ?? process.cwd(), "..", "logs");
try {
  fs.mkdirSync(logsDir, { recursive: true });
} catch (err) {
  console.warn(`could not create logs dir ${logsDir}:`, (err as Error).message);
}

const zalo = new ZaloClient({
  credsPath: config.zalo.credsPath,
  messagesPerMinute: config.zalo.messagesPerMinute,
  burst: config.zalo.burst,
});

const store = new MappingStore(config.bridge.dbPath);

const ctx: BotCommandContext = {
  // bridge is assigned right below; handleBotEvent only runs after startBridge
  bridge: undefined as unknown as BotCommandContext["bridge"],
  zalo,
  ownerUserId: config.matrix.owner,
};

const echo = new EchoSuppressor();

const bridge = await createBridge(
  config,
  async (event) => {
    // Portal rooms carry conversation traffic (outbound); everything else is bot commands
    if (event.room_id && store.isPortalRoom(event.room_id)) {
      await outbound.handle(event);
      return;
    }
    await handleBotEvent(ctx, event);
  },
  async (event) => {
    // Ephemeral: owner's read receipts + typing in a portal → mirror onto Zalo.
    // Presence events carry no room_id and are ignored.
    if (event.type === "m.receipt") {
      if (store.isPortalRoom(event.room_id)) await presence.handleOwnerReceipt(event.room_id, event.content as Record<string, unknown>);
    }
    // Typing mirroring disabled on request — re-enable by uncommenting:
    // else if (event.type === "m.typing") {
    //   if (store.isPortalRoom(event.room_id)) await presence.handleOwnerTyping(event.room_id, event.content.user_ids ?? []);
    // }
  },
  {
    // When bbctl proxy restarts, Beeper resets the bridge-level state to UNCONFIGURED;
    // the first transaction after the gap is our signal to republish the true state.
    onProxyReconnected: () => {
      void zaloState.onProxyReconnected();
    },
    // Set for real once the registration is parsed below (events only flow after that).
    isAppserviceUser: (sender) => appserviceUserFilter(sender),
  },
);
ctx.bridge = bridge;

// Registration holds the as_token, ghost namespace, and the appservice id used
// to build the bridge-info state_key (<domain>/<appservice-id>, e.g. beeper.local/sh-zalo)
const registration = loadYaml(fs.readFileSync(config.matrix.registrationPath, "utf8")) as {
  as_token?: string;
  sender_localpart?: string;
  namespaces?: { users?: Array<{ regex: string }> };
};
const asToken = registration.as_token;
if (!asToken) throw new Error(`No as_token in ${config.matrix.registrationPath}`);
// appservice id = sender_localpart minus the trailing "bot" (sh-zalobot → sh-zalo)
const bridgeAppId = (registration.sender_localpart ?? "sh-zalobot").replace(/bot$/, "");

// Ghosts + the bot speak "as the appservice": their echoes must not be re-dispatched
// (same filter Bridge.suppressEcho applied before the deferred-ack hook took over).
let appserviceUserFilter: (sender: string) => boolean = () => false;
{
  const usersRegex = registration.namespaces?.users?.[0]?.regex;
  if (usersRegex) {
    const compiled = new RegExp(usersRegex);
    const botMxid = `@${registration.sender_localpart}:${config.matrix.domain}`;
    appserviceUserFilter = (sender) => compiled.test(sender) || sender === botMxid;
  }
}
const branding = {
  ...config.network,
  stateKey: `${config.matrix.domain}/${bridgeAppId}`,
};

// Shared between in/out handlers: event_ids the bridge posted as the owner (own
// phone messages) + events already sent outbound — prevents re-sending / loops.
const bridgedEventIds = new Set<string>();

const puppets = new PuppetRegistry(bridge, store, config.matrix.domain, (uid) => zalo.getUserProfile(uid), bridgeAppId);
const portals = new PortalManager(bridge, store, puppets, config.matrix.owner, branding);
const inbound = new InboundHandler({
  bridge,
  store,
  puppets,
  portals,
  echo,
  ownerUserId: config.matrix.owner,
  mediaMaxBytes: config.bridge.mediaMaxBytes,
  resolveGroupName: (threadId) => zalo.getGroupName(threadId),
  resolveStickerUrl: (stickerId) => zalo.getStickerImageUrl(stickerId),
  getOwnZaloId: () => zalo.ownId,
  bridgedEventIds,
});

const outbound = new OutboundHandler({
  bridge,
  store,
  zalo,
  echo,
  ownerUserId: config.matrix.owner,
  mediaMaxBytes: config.bridge.mediaMaxBytes,
  homeserverUrl: config.matrix.homeserverUrl,
  matrixToken: asToken,
  bridgedEventIds,
  ghostPrefix: puppets.ghostPrefix,
});
const sync = new SyncManager({ zalo, portals, inbound });
ctx.runSync = () => sync.run();

// Fail fast if computed ghost MXIDs cannot be registered under this appservice
const usersRegex = registration.namespaces?.users?.[0]?.regex;
if (!usersRegex) throw new Error(`No user namespace in ${config.matrix.registrationPath}`);
assertGhostNamespace(usersRegex, puppets.mxidFor("1234567890"));

// Beeper needs a remote-account state to show the network and its chats
// (see beeper-bridge-state.ts — an explicit observe→publish state machine).
const zaloState = createZaloStateMachine({
  homeserverUrl: config.matrix.homeserverUrl,
  bridgeId: bridgeAppId,
  asToken,
  fallbackName: config.network.name,
  // Read fresh on every publish + heartbeat tick — never a cached state.
  getSnapshot: () => ({ loggedIn: zalo.isLoggedIn, ownId: zalo.ownId, listener: zalo.status.listener }),
  getOwnProfile: (uid) => zalo.getUserProfile(uid),
  uploadAvatar: async (url) => {
    const { buffer, mimetype } = await fetchMediaCapped(url, AVATAR_MAX_BYTES);
    return bridge.getIntent().uploadContent(buffer, { type: mimetype, name: "zalo-avatar" });
  },
});

// The bot's `logout` command drops the session; report it to Beeper right away
// (wrapping here keeps the bot-command layer decoupled from Beeper reporting).
const { logout: baseLogout } = zalo;
zalo.logout = () => {
  baseLogout.call(zalo);
  void zaloState.loggedOut("logout command");
};

zalo.on("connected", () => {
  console.log("[zalo] listener connected");
  void zaloState.publishIfChanged();
});
zalo.on("reconnecting", (attempt, delayMs) => {
  console.warn(`[zalo] listener reconnecting (attempt ${attempt}, in ${delayMs}ms)`);
  void zaloState.publishIfChanged();
});
zalo.on("dead", (reason) => {
  console.error(`[zalo] listener DEAD: ${reason} — send 'login' in the management room`);
  // Generic DISCONNECTED, NOT BAD_CREDENTIALS: a dead listener usually means the socket
  // was stolen or kept closing — saved cookies are often still valid, and claiming
  // credentials failure would push the user into a needless QR relogin.
  void zaloState.publishIfChanged();
});
zalo.on("message", (msg) => inbound.handle(msg));
const presence = new PresenceHandler(store, puppets, zalo, config.matrix.owner, () => zalo.ownId);
zalo.on("seen", (ev) => void presence.handleSeen(ev).catch((err) => console.warn("seen handling failed:", err)));
// Typing mirroring disabled on request — re-enable by uncommenting:
// zalo.on("typing", (ev) => void presence.handleTyping(ev).catch((err) => console.warn("typing handling failed:", err)));
zalo.on("reaction", (ev) => void presence.handleReaction(ev).catch((err) => console.warn("reaction handling failed:", err)));

// Appservice MUST be up before the Zalo listener: intents throw pre-initialise,
// and the old_messages replay burst arrives immediately on ws connect
await startBridge(bridge, config);
await ensureNetworkIdentity(bridge, branding);
// Backfill the network chip on portals created before branding existed
void portals.rebrandExistingPortals().catch((err) => console.warn("portal rebrand failed:", err));

// Silent cookie re-login at startup; QR (via 'login' command) when absent/expired
if (await zalo.loginFromSavedCredentials()) {
  zalo.startListening();
  console.log(`[zalo] re-logged in from saved credentials (uid ${zalo.ownId})`);
} else {
  console.log("[zalo] no valid saved credentials — send 'login' to the bot from Beeper");
}

// Process-level safety nets: without these, one unhandled rejection turns launchd's
// KeepAlive into a tight crash-restart loop, and SIGTERM kills in-flight sends.
process.on("unhandledRejection", (reason) => {
  console.error("[bridge] unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[bridge] uncaught exception — exiting:", err);
  process.exit(1);
});

const SHUTDOWN_GRACE_MS = 5_000;
let shuttingDown = false;

function handleShutdownSignal(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bridge] ${signal} received — stopping listeners (force exit in ${SHUTDOWN_GRACE_MS / 1000}s)`);
  // Bounded backstop: even if a promise wedges, we exit cleanly within the grace window.
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  try {
    zalo.stopListening(); // stop consuming Zalo events; in-flight sends keep their sockets
  } catch (err) {
    console.warn("stopListening during shutdown failed:", (err as Error).message);
  }
  // Close the appservice listener so no new transactions arrive; the process then exits
  // naturally once in-flight sends settle and the event loop drains.
  void bridge.close().catch((err: Error) => console.warn("bridge close failed:", err.message));
}

process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
