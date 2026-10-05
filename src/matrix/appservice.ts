// Matrix appservice wiring: Bridge instance + event routing.
// bbctl proxy holds the websocket to Beeper and forwards to our local HTTP port.
import { AppService } from "matrix-appservice";
import type { Bridge, EphemeralEvent, Request, WeakEvent } from "matrix-appservice-bridge";
import type { BridgeConfig } from "../config.ts";

// matrix-appservice only parses ephemeral EDUs from the UNSTABLE MSC2409 key
// (`de.sorunome.msc2409.ephemeral`), but Beeper/hungryserv sends them under the
// STABLE `ephemeral` key — so read receipts and typing were silently dropped.
// Patch the transaction handler (before any AppService is constructed) to mirror
// the stable key onto the unstable one the library reads.
type TxnBody = Record<string, unknown> & {
  events?: WeakEvent[];
  ephemeral?: unknown;
  "de.sorunome.msc2409.ephemeral"?: EphemeralEvent[];
};
const appServiceProto = AppService.prototype as unknown as {
  onTransaction: (this: PatchedAppService, req: TxnRequest, res: TxnResponse) => void;
};
const originalOnTransaction = appServiceProto.onTransaction;

// Minimal structural types for the express req/res shapes onTransaction touches.
interface TxnRequest {
  body?: TxnBody;
  params?: { txnId?: string };
}
interface TxnResponse {
  status(code: number): TxnResponse;
  send(body?: unknown): TxnResponse;
}
/** The slice of matrix-appservice's AppService the patch touches (declared `private`
 * upstream, so it can only be reached through a structural cast — hence not an
 * intersection with AppService, which TS would collapse to `never`). */
interface PatchedAppService {
  isInvalidToken(req: TxnRequest, res: TxnResponse): boolean;
  lastProcessedTxnId: string;
  emit(event: string, ...args: unknown[]): boolean;
}

// ---------------------------------------------------------------------------
// Deferred transaction acking.
// Stock matrix-appservice sends `res.send({})` the moment it has emitted the events,
// BEFORE consumer handlers run: a crash mid-send loses the message with no retry
// (the homeserver saw a 200 and will never redeliver). The patched onTransaction
// below keeps message/reaction transactions unacked until their handlers finish,
// so a proxy retry (or a post-crash redelivery) replays them. Ephemeral traffic
// (receipts/typing) is still acked immediately — losing one is harmless, and
// holding the ack would stall rooms behind slow handlers.
// ---------------------------------------------------------------------------

/** Registered by createBridge; runs the message-event handlers for one transaction. */
type InboundTxnHook = (body: TxnBody) => Promise<void>;
let txnAckHook: InboundTxnHook | null = null;

export function setTransactionAckHook(hook: InboundTxnHook | null): void {
  txnAckHook = hook;
}

appServiceProto.onTransaction = function patchedOnTransaction(this: PatchedAppService, req: TxnRequest, res: TxnResponse) {
  const body = req.body;
  if (body && body["de.sorunome.msc2409.ephemeral"] === undefined && body.ephemeral !== undefined) {
    body["de.sorunome.msc2409.ephemeral"] = body.ephemeral as EphemeralEvent[];
  }
  const hook = txnAckHook;
  if (!hook) return originalOnTransaction.call(this, req, res);

  noteInboundTraffic();
  if (this.isInvalidToken(req, res)) return;
  const txnId = req.params?.txnId;
  if (!txnId) {
    res.send("Missing transaction ID.");
    return;
  }
  if (!body) {
    res.send("Missing body.");
    return;
  }
  // Dedupe BEFORE processing: a proxy timeout retried while the first attempt is
  // still running must not run the handlers twice.
  if (this.lastProcessedTxnId === txnId) {
    res.send({}); // duplicate
    return;
  }
  this.lastProcessedTxnId = txnId;

  // Ephemeral (receipts/typing): emit + ack immediately.
  for (const event of body["de.sorunome.msc2409.ephemeral"] ?? []) {
    this.emit("ephemeral", event);
    if (event.type) this.emit(`ephemeral_type:${event.type}`, event);
  }

  // Message/reaction traffic: respond only after the handlers finish. A handler
  // error must still ack (the proxy would otherwise redeliver the same transaction
  // forever — a poison-message loop); the error is logged and the event dropped.
  void (async () => {
    try {
      await hook(body);
    } catch (err) {
      console.error("[matrix] inbound handler failed (acking anyway to avoid a poison-message loop):", err);
    }
    try {
      res.send({});
    } catch {
      // connection already gone — the proxy timed out and will retry the txnId
    }
  })();
};

// ---------------------------------------------------------------------------
// Proxy reconnection detection.
// bbctl proxy only talks to us over HTTP transactions; when it restarts, Beeper's
// bridge-level state resets to UNCONFIGURED and nothing restores it. The first
// transaction after a quiet gap is the signal that the proxy is back.
// ---------------------------------------------------------------------------

export const PROXY_RECONNECT_GAP_MS = 60_000;
let lastInboundTxnAt = Date.now();
let onTrafficResume: (() => void) | null = null;

export function setProxyReconnectListener(listener: (() => void) | null): void {
  onTrafficResume = listener;
}

function noteInboundTraffic(): void {
  const now = Date.now();
  const resumed = now - lastInboundTxnAt >= PROXY_RECONNECT_GAP_MS;
  lastInboundTxnAt = now;
  if (resumed && onTrafficResume) {
    console.log("[matrix] appservice traffic resumed after a gap — bbctl proxy likely reconnected");
    try {
      onTrafficResume();
    } catch (err) {
      console.warn("[matrix] reconnect callback failed:", (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound dispatch: per-sender serialization + handler timeout.
// ---------------------------------------------------------------------------

/** A hung Matrix call must not wedge a conversation's inbound queue forever: past the
 * timeout the slot is released (the handler promise keeps running in the background). */
export const HANDLER_TIMEOUT_MS = 60_000;

export function createInboundEventDispatcher(
  onEvent: (event: WeakEvent) => Promise<void> | void,
  timeoutMs = HANDLER_TIMEOUT_MS,
): (event: WeakEvent) => Promise<void> {
  // sender → tail of that sender's handler chain (at most one handler in flight each;
  // pipelined transactions wait, bounded by the per-handler timeout so it can't wedge)
  const chains = new Map<string, Promise<void>>();
  return (event: WeakEvent) => {
    const key = event.sender ?? "?";
    const prev = chains.get(key) ?? Promise.resolve();
    const slot = prev.then(
      () => withHandlerTimeout(onEvent(event), timeoutMs, `${event.type} from ${event.sender ?? "?"}`),
      () => withHandlerTimeout(onEvent(event), timeoutMs, `${event.type} from ${event.sender ?? "?"}`),
    );
    const tail = slot.then(() => undefined, () => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return slot;
  };
}

function withHandlerTimeout(run: Promise<void> | void, timeoutMs: number, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      console.error(`[matrix] inbound handler exceeded ${timeoutMs}ms — releasing the queue slot (handler keeps running): ${label}`);
      resolve();
    }, timeoutMs);
    timer.unref();
    void Promise.resolve(run).then(
      () => {
        if (timer) clearTimeout(timer);
        resolve();
      },
      (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------

export type MatrixEventHandler = (event: WeakEvent) => Promise<void> | void;
// Read receipts and typing arrive via a SEPARATE controller callback, not onEvent
export type MatrixEphemeralHandler = (event: EphemeralEvent) => Promise<void> | void;

export interface CreateBridgeOptions {
  /** Called when appservice traffic resumes after a quiet gap (bbctl proxy restart). */
  onProxyReconnected?: () => void;
  /** True for senders that belong to the appservice itself (ghosts + the bot).
   * Bridge's `suppressEcho` used to drop those before the controller; the
   * deferred-ack hook bypasses Bridge.onEvent, so the filter moved here. */
  isAppserviceUser?: (sender: string) => boolean;
}

export async function createBridge(config: BridgeConfig, onEvent: MatrixEventHandler, onEphemeral: MatrixEphemeralHandler, options: CreateBridgeOptions = {}): Promise<Bridge> {
  // Transaction events flow through the deferred-ack hook (see the patch above) so a
  // crash mid-send is retried by the proxy instead of lost.
  const dispatchInbound = createInboundEventDispatcher(onEvent);
  setTransactionAckHook(async (body) => {
    for (const event of body.events ?? []) {
      // Echoes of the bridge's own posts (ghosts/bot) never reached the controller
      // while Bridge.suppressEcho was in the path — keep it that way.
      if (event.sender && options.isAppserviceUser?.(event.sender)) continue;
      await dispatchInbound(event);
    }
  });
  setProxyReconnectListener(options.onProxyReconnected ?? null);

  const runGuarded = (label: string, fn: () => Promise<void> | void, ctx: string) => {
    void (async () => {
      try {
        await fn();
      } catch (err) {
        console.error(`${label} failed for ${ctx}:`, err);
      }
    })();
  };

  // Loaded lazily: matrix-appservice-bridge pulls an optional native crypto module
  // that plain unit tests must not require.
  const { Bridge } = await import("matrix-appservice-bridge");
  const bridge = new Bridge({
    homeserverUrl: config.matrix.homeserverUrl,
    domain: config.matrix.domain,
    registration: config.matrix.registrationPath,
    // Own mapping store comes in Phase 4 (SQLite) — skip nedb stores entirely
    disableStores: true,
    // Fallback path only: with the ack hook registered, patchedOnTransaction routes
    // transactions itself and never emits plain "event"s — this controller would only
    // fire from some other emitter of AppService "event"s.
    controller: {
      onEvent: (request: Request<WeakEvent>) => {
        const event = request.getData();
        runGuarded("onEvent", () => onEvent(event), `${event.type} in ${event.room_id}`);
      },
      onEphemeralEvent: (request: Request<EphemeralEvent>) => {
        const event = request.getData();
        runGuarded("onEphemeralEvent", () => onEphemeral(event), event.type);
      },
    },
  });
  return bridge;
}

export async function startBridge(bridge: Bridge, config: BridgeConfig): Promise<void> {
  // Loopback only — bbctl proxy is the sole legitimate caller; keep 29350 off the LAN
  await bridge.run(config.matrix.port, undefined, "127.0.0.1");
  console.log(`Appservice listening on localhost:${config.matrix.port} (run 'bbctl proxy -r ${config.matrix.registrationPath}' alongside)`);
}
