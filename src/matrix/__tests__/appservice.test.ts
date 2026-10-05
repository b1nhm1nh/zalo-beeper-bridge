// Inbound transaction behavior: ack AFTER message handlers finish (crash-safe retry),
// per-sender serialization with a timeout that can't wedge the queue, and proxy
// reconnection detection from a quiet-gap in appservice traffic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppService } from "matrix-appservice";
import type { WeakEvent } from "matrix-appservice-bridge";
import {
  HANDLER_TIMEOUT_MS,
  PROXY_RECONNECT_GAP_MS,
  createInboundEventDispatcher,
  setProxyReconnectListener,
  setTransactionAckHook,
} from "../appservice.ts";

function messageEvent(overrides: Partial<WeakEvent> = {}): WeakEvent {
  return {
    type: "m.room.message",
    room_id: "!room:x",
    sender: "@owner:beeper.com",
    event_id: "$e",
    origin_server_ts: 0,
    content: {},
    ...overrides,
  } as WeakEvent;
}

// Fake `this` for the patched AppService.prototype.onTransaction (structural — the real
// class declares these members private, so the patch reaches them via casts).
function fakeAppService() {
  return {
    isInvalidToken: vi.fn(() => false),
    lastProcessedTxnId: "",
    emit: vi.fn(),
  };
}

function fakeRes() {
  return {
    status: vi.fn(function (this: unknown, _code: number) {
      return this as never;
    }),
    send: vi.fn(),
  };
}

describe("createInboundEventDispatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes events for the same sender in order", async () => {
    const order: string[] = [];
    const dispatch = createInboundEventDispatcher(async (event) => {
      await Promise.resolve();
      order.push((event.content as { body?: string }).body ?? "");
    });
    const a = dispatch(messageEvent({ event_id: "$a", content: { body: "a" } }));
    const b = dispatch(messageEvent({ event_id: "$b", content: { body: "b" } }));
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("does not block different senders behind a hung handler", async () => {
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handled: string[] = [];
    const dispatch = createInboundEventDispatcher(async (event) => {
      if (event.event_id === "$slow") {
        await first;
        return;
      }
      handled.push(event.sender ?? "");
    });
    void dispatch(messageEvent({ event_id: "$slow", sender: "@slow:x" }));
    await dispatch(messageEvent({ event_id: "$fast", sender: "@fast:x" }));
    expect(handled).toEqual(["@fast:x"]);
    releaseFirst?.();
  });

  it("releases the queue slot after the handler timeout (handler keeps running)", async () => {
    const handled: string[] = [];
    let secondStarted = false;
    const dispatch = createInboundEventDispatcher(
      async (event) => {
        if (event.event_id === "$hang") {
          await new Promise(() => undefined); // hung Matrix call
        }
        handled.push(event.event_id ?? "");
        if (event.event_id === "$second") secondStarted = true;
      },
      25, // small timeout for the test
    );
    void dispatch(messageEvent({ event_id: "$hang" }));
    const second = dispatch(messageEvent({ event_id: "$second" }));
    await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS + 100);
    await second;
    expect(secondStarted).toBe(true);
    expect(handled).toContain("$second");
  });
});

describe("patched onTransaction (deferred ack)", () => {
  // The patch replaced AppService.prototype.onTransaction (declared private upstream);
  // exercise it directly with a structural fake `this`.
  type TxnFn = (
    this: { isInvalidToken(req: unknown, res: unknown): boolean; lastProcessedTxnId: string; emit(event: string, ...args: unknown[]): boolean },
    req: unknown,
    res: unknown,
  ) => void;
  const onTransaction = (AppService.prototype as unknown as { onTransaction: TxnFn }).onTransaction;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    setTransactionAckHook(null);
    setProxyReconnectListener(null);
    vi.useRealTimers();
  });

  it("acks message transactions only AFTER the hook completes", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    setTransactionAckHook(async () => {
      order.push("hook:start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("hook:done");
    });
    const as = fakeAppService();
    const res = fakeRes();
    onTransaction.call(
      as,
      { body: { events: [messageEvent()] }, params: { txnId: "t1" } },
      res,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(as.lastProcessedTxnId).toBe("t1");
    expect(res.send).not.toHaveBeenCalled(); // still unacked while the handler runs
    release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["hook:start", "hook:done"]);
    expect(res.send).toHaveBeenCalledWith({});
  });

  it("acks even when the handler fails (no poison-message loop)", async () => {
    setTransactionAckHook(async () => {
      throw new Error("boom");
    });
    const as = fakeAppService();
    const res = fakeRes();
    onTransaction.call(as, { body: { events: [messageEvent()] }, params: { txnId: "t1" } }, res);
    await vi.advanceTimersByTimeAsync(1);
    expect(res.send).toHaveBeenCalledWith({});
  });

  it("treats a duplicate txnId as already-processed and acks immediately", async () => {
    const hook = vi.fn(async () => undefined);
    setTransactionAckHook(hook);
    const as = fakeAppService();
    as.lastProcessedTxnId = "t1"; // proxy retry of the same transaction
    const res = fakeRes();
    onTransaction.call(as, { body: { events: [messageEvent()] }, params: { txnId: "t1" } }, res);
    expect(res.send).toHaveBeenCalledWith({}); // synchronous ack
    expect(hook).not.toHaveBeenCalled();
  });

  it("emits ephemeral events and acks ephemeral-only transactions immediately", async () => {
    setTransactionAckHook(async () => undefined);
    const as = fakeAppService();
    const res = fakeRes();
    onTransaction.call(
      as,
      { body: { ephemeral: [{ type: "m.receipt", content: {} }] }, params: { txnId: "t1" } },
      res,
    );
    // synchronous: mirrored onto the unstable key + emitted before any await
    expect(as.emit).toHaveBeenCalledWith("ephemeral", { type: "m.receipt", content: {} });
    expect(as.emit).toHaveBeenCalledWith("ephemeral_type:m.receipt", { type: "m.receipt", content: {} });
    await vi.advanceTimersByTimeAsync(1);
    expect(res.send).toHaveBeenCalledWith({});
  });

  it("falls back to the stock behaviour when no hook is registered", async () => {
    const as = fakeAppService();
    const res = fakeRes();
    onTransaction.call(as, { body: { events: [messageEvent()] }, params: { txnId: "t1" } }, res);
    expect(as.emit).toHaveBeenCalledWith("event", expect.objectContaining({ type: "m.room.message" }));
    expect(res.send).toHaveBeenCalledWith({});
  });

  it("notifies the proxy-reconnect listener when traffic resumes after a quiet gap", async () => {
    setTransactionAckHook(async () => undefined);
    const onReconnect = vi.fn();
    setProxyReconnectListener(onReconnect);
    const as = fakeAppService();
    onTransaction.call(as, { body: { events: [] }, params: { txnId: "t1" } }, fakeRes());
    await vi.advanceTimersByTimeAsync(1);
    expect(onReconnect).not.toHaveBeenCalled(); // first transaction: no gap yet

    await vi.advanceTimersByTimeAsync(PROXY_RECONNECT_GAP_MS + 1);
    onTransaction.call(as, { body: { events: [] }, params: { txnId: "t2" } }, fakeRes());
    await vi.advanceTimersByTimeAsync(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
