// Suppresses the selfListen echo of messages the bridge just sent to Zalo.
//
// When the owner types in Beeper → we send to Zalo → zca-js selfListen delivers
// that same message back with isSelf=true. Without suppression it would be
// re-posted into the portal as a duplicate. msgId from the send response can lag
// the echo, so when the msgId is known we match on it EXACTLY; only markers armed
// without a msgId fall back to a (threadId, content) match. That fallback window
// is kept very short: a phone-typed message with the same short text ("ok") as a
// recent Beeper send must not be swallowed for long.
const TTL_MS = 3_000;

interface PendingEcho {
  text: string;
  /** Zalo msgId of the send we're guarding — exact-match key when known. */
  msgId: string | null;
  expiresAt: number;
}

export interface EchoExpectOpts {
  /** msgId returned by the send, when already known at arm time. */
  msgId?: string;
  /** Override the default suppression window (ms). */
  ttlMs?: number;
}

export class EchoSuppressor {
  private readonly pending = new Map<string, PendingEcho[]>();
  // Outbound images have neither a pre-send msgId nor a known CDN url, so guard by
  // a per-thread "image just sent" window: threadId → array of send markers
  private readonly pendingImages = new Map<string, PendingEcho[]>();

  /** Arm BEFORE sending an image (we don't yet know its msgId or CDN url). */
  expectImage(threadId: string, opts?: EchoExpectOpts): void {
    const list = (this.pendingImages.get(threadId) ?? []).filter((e) => e.expiresAt > Date.now());
    list.push({ text: "", msgId: opts?.msgId ?? null, expiresAt: Date.now() + (opts?.ttlMs ?? TTL_MS) });
    this.pendingImages.set(threadId, list);
  }

  /** True (consuming one marker) when a self photo in this thread is our own echo.
   * Prefers exact msgId equality; a marker armed blind (no msgId) absorbs any
   * image echo while it is still fresh. */
  consumeImage(threadId: string, msgId?: string): boolean {
    const list = this.pendingImages.get(threadId);
    if (!list) return false;
    const now = Date.now();
    let idx = -1;
    if (msgId) {
      idx = list.findIndex((e) => e.expiresAt > now && e.msgId === msgId);
      if (idx === -1) idx = list.findIndex((e) => e.expiresAt > now && !e.msgId);
    } else {
      idx = list.findIndex((e) => e.expiresAt > now);
    }
    const fresh = list.filter((e) => e.expiresAt > now && e !== list[idx]);
    if (fresh.length) this.pendingImages.set(threadId, fresh);
    else this.pendingImages.delete(threadId);
    return idx !== -1;
  }

  /** Removes one pending image marker — call when an image send FAILED so a real
   * phone-sent photo isn't wrongly swallowed. */
  cancelImage(threadId: string): void {
    const list = this.pendingImages.get(threadId);
    if (!list) return;
    list.shift(); // markers expire in arm order; drop the oldest
    if (!list.length) this.pendingImages.delete(threadId);
    else this.pendingImages.set(threadId, list);
  }

  /** Call right before sending to Zalo. Pass the send's msgId when known so the
   * echo can be matched exactly instead of by text. */
  expect(threadId: string, text: string, opts?: EchoExpectOpts): void {
    const list = (this.pending.get(threadId) ?? []).filter((e) => e.expiresAt > Date.now());
    list.push({ text, msgId: opts?.msgId ?? null, expiresAt: Date.now() + (opts?.ttlMs ?? TTL_MS) });
    this.pending.set(threadId, list);
  }

  /** Removes one pending entry — call when a send FAILED so a real phone-typed
   * message with identical text isn't wrongly swallowed. */
  cancel(threadId: string, text: string): void {
    const list = this.pending.get(threadId);
    if (!list) return;
    const idx = list.findIndex((e) => e.text === text);
    if (idx !== -1) list.splice(idx, 1);
    if (!list.length) this.pending.delete(threadId);
  }

  /** Returns true (and consumes the entry) when this self-message is our own echo.
   * Exact msgId equality wins when both sides know one (a different msgId means a
   * different message — never swallowed); otherwise fall back to (threadId, text)
   * while the marker is still fresh. */
  consume(threadId: string, text: string, msgId?: string): boolean {
    const list = this.pending.get(threadId);
    if (!list) return false;
    const now = Date.now();
    const idx = list.findIndex((e) => e.expiresAt > now && this.matches(e, text, msgId));
    // Drop expired entries opportunistically
    const fresh = list.filter((e) => e.expiresAt > now && e !== list[idx]);
    if (fresh.length) this.pending.set(threadId, fresh);
    else this.pending.delete(threadId);
    return idx !== -1;
  }

  /** Exact msgId match when both sides carry one; text match otherwise. */
  private matches(entry: PendingEcho, text: string, msgId?: string): boolean {
    if (entry.msgId && msgId) return entry.msgId === msgId;
    return entry.text === text;
  }
}
