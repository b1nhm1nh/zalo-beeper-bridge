import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EchoSuppressor } from "../echo-suppressor.ts";

describe("EchoSuppressor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("consumes a matching echo exactly once", () => {
    const echo = new EchoSuppressor();
    echo.expect("t1", "hello");
    expect(echo.consume("t1", "hello")).toBe(true);
    expect(echo.consume("t1", "hello")).toBe(false); // already consumed
  });

  it("does not suppress a different message on the same thread", () => {
    const echo = new EchoSuppressor();
    echo.expect("t1", "hello");
    expect(echo.consume("t1", "world")).toBe(false);
    expect(echo.consume("t1", "hello")).toBe(true); // untouched by the miss
  });

  it("scopes suppression per thread", () => {
    const echo = new EchoSuppressor();
    echo.expect("t1", "hi");
    expect(echo.consume("t2", "hi")).toBe(false);
  });

  it("expires entries after the short TTL window (phone-typed dupes survive it)", () => {
    const echo = new EchoSuppressor();
    echo.expect("t1", "ok");
    vi.advanceTimersByTime(3_001);
    expect(echo.consume("t1", "ok")).toBe(false); // a phone-typed "ok" after this is NOT an echo
  });

  it("honours a per-expect ttlMs override", () => {
    const echo = new EchoSuppressor();
    echo.expect("t1", "hi", { ttlMs: 100 });
    vi.advanceTimersByTime(101);
    expect(echo.consume("t1", "hi")).toBe(false);
  });

  it("handles duplicate identical sends (two echoes expected)", () => {
    const echo = new EchoSuppressor();
    echo.expect("t1", "ok");
    echo.expect("t1", "ok");
    expect(echo.consume("t1", "ok")).toBe(true);
    expect(echo.consume("t1", "ok")).toBe(true);
    expect(echo.consume("t1", "ok")).toBe(false);
  });

  describe("msgId-exact matching", () => {
    it("consumes by msgId even when the text differs", () => {
      const echo = new EchoSuppressor();
      echo.expect("t1", "hello", { msgId: "m1" });
      expect(echo.consume("t1", "hello", "m1")).toBe(true);
    });

    it("does NOT swallow a phone-typed message with the same text but a different msgId", () => {
      const echo = new EchoSuppressor();
      echo.expect("t1", "ok", { msgId: "m-send" });
      expect(echo.consume("t1", "ok", "m-phone")).toBe(false); // real user message — keep it
      expect(echo.consume("t1", "ok", "m-send")).toBe(true); // the real echo still suppressed
    });

    it("prefers msgId over text when both sides have one", () => {
      const echo = new EchoSuppressor();
      echo.expect("t1", "first", { msgId: "m1" });
      // same msgId, different text → still our echo
      expect(echo.consume("t1", "second", "m1")).toBe(true);
    });

    it("falls back to text when the marker was armed without a msgId", () => {
      const echo = new EchoSuppressor();
      echo.expect("t1", "ok");
      expect(echo.consume("t1", "ok", "m-echo")).toBe(true);
    });

    it("falls back to text when the caller has no msgId", () => {
      const echo = new EchoSuppressor();
      echo.expect("t1", "ok", { msgId: "m1" });
      expect(echo.consume("t1", "ok")).toBe(true);
    });

    it("text fallback still expires within the 3s window", () => {
      const echo = new EchoSuppressor();
      echo.expect("t1", "ok", { msgId: "m1" });
      vi.advanceTimersByTime(3_001);
      expect(echo.consume("t1", "ok")).toBe(false);
    });
  });

  describe("images", () => {
    it("consumes an image echo within the short TTL", () => {
      const echo = new EchoSuppressor();
      echo.expectImage("t1");
      expect(echo.consumeImage("t1")).toBe(true);
      expect(echo.consumeImage("t1")).toBe(false); // once only
    });

    it("expires image markers after 3s", () => {
      const echo = new EchoSuppressor();
      echo.expectImage("t1");
      vi.advanceTimersByTime(3_001);
      expect(echo.consumeImage("t1")).toBe(false);
    });

    it("prefers exact msgId, falling back to blind markers only", () => {
      const echo = new EchoSuppressor();
      echo.expectImage("t1", { msgId: "im1" });
      expect(echo.consumeImage("t1", "im-other")).toBe(false); // different image — not ours
      expect(echo.consumeImage("t1", "im1")).toBe(true);
    });

    it("a blind marker absorbs any image echo", () => {
      const echo = new EchoSuppressor();
      echo.expectImage("t1");
      expect(echo.consumeImage("t1", "whatever")).toBe(true);
    });

    it("cancelImage drops the marker after a failed send", () => {
      const echo = new EchoSuppressor();
      echo.expectImage("t1");
      echo.cancelImage("t1");
      expect(echo.consumeImage("t1")).toBe(false);
    });
  });

  it("cancel removes a pending marker so a failed send doesn't swallow real messages", () => {
    const echo = new EchoSuppressor();
    echo.expect("t1", "hello");
    echo.cancel("t1", "hello");
    expect(echo.consume("t1", "hello")).toBe(false);
  });
});
