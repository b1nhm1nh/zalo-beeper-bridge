// Ghost MXID prefix derivation: from the bbctl registration id / sender_localpart,
// never hardcoded — ghosts must stay inside the appservice's own user namespace.
import { describe, expect, it } from "vitest";
import type { Bridge } from "matrix-appservice-bridge";
import { DEFAULT_GHOST_PREFIX, PuppetRegistry, deriveGhostPrefix } from "../puppet-registry.ts";

const storeStub = {
  upsertPuppet: () => false,
  getPuppetAvatarUrl: () => null,
} as never;

const bridgeStub = {
  getIntent: () => ({
    ensureRegistered: async () => undefined,
    setDisplayName: async () => undefined,
  }),
} as unknown as Bridge;

describe("deriveGhostPrefix", () => {
  it("derives the prefix from the registration id", () => {
    expect(deriveGhostPrefix("sh-zalo")).toBe("sh-zalo_");
  });

  it("strips the bbctl 'bot' suffix from sender_localpart", () => {
    expect(deriveGhostPrefix("sh-zalobot")).toBe("sh-zalo_");
  });

  it("falls back to the historical prefix when the id is absent", () => {
    expect(deriveGhostPrefix(undefined)).toBe(DEFAULT_GHOST_PREFIX);
    expect(deriveGhostPrefix(null)).toBe(DEFAULT_GHOST_PREFIX);
    expect(deriveGhostPrefix("  ")).toBe(DEFAULT_GHOST_PREFIX);
  });

  it("keeps unrelated ids verbatim", () => {
    expect(deriveGhostPrefix("myzalo")).toBe("myzalo_");
  });

  it("mxidFor uses the derived prefix for every call site", () => {
    const puppets = new PuppetRegistry(bridgeStub, storeStub, "beeper.local", undefined, "sh-zalobot");
    expect(puppets.mxidFor("12345")).toBe("@sh-zalo_12345:beeper.local");
    expect(puppets.ghostPrefix).toBe("sh-zalo_");
  });
});
