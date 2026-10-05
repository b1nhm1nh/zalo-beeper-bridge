import { describe, expect, it } from "vitest";
import { Reactions } from "zca-js";
import { emojiToZalo, zaloToEmoji } from "../reaction-map.ts";

const ALL_CODES = Object.values(Reactions).filter((code) => code !== Reactions.NONE);

describe("reaction-map", () => {
  it("maps common emoji to Zalo icon codes", () => {
    expect(emojiToZalo("❤️")).toBe(Reactions.HEART);
    expect(emojiToZalo("👍")).toBe(Reactions.LIKE);
    expect(emojiToZalo("😂")).toBe(Reactions.TEARS_OF_JOY);
  });

  it("falls back to HEART for unmapped emoji", () => {
    expect(emojiToZalo("🦄")).toBe(Reactions.HEART);
  });

  it("maps Zalo icon codes back to emoji", () => {
    expect(zaloToEmoji(Reactions.LIKE)).toBe("👍");
    expect(zaloToEmoji(Reactions.CRY)).toBe("😢");
  });

  it("maps the codes that used to be missing", () => {
    expect(zaloToEmoji(Reactions.BIG_LAUGH)).toBe("😆");
    expect(zaloToEmoji(Reactions.LOVE)).toBe("😍");
    expect(zaloToEmoji(Reactions.WINK)).toBe("😉");
    expect(zaloToEmoji(Reactions.OK)).toBe("👌");
    expect(zaloToEmoji(Reactions.BEER)).toBe("🍺");
    expect(zaloToEmoji(Reactions.PRAY)).toBe("🙏");
    expect(zaloToEmoji(Reactions.SUNGLASSES)).toBe("😎");
    expect(zaloToEmoji(Reactions.SHIT)).toBe("💩");
  });

  it("covers EVERY zca-js reaction code (none falls through unmapped)", () => {
    expect(ALL_CODES.length).toBeGreaterThan(40);
    for (const code of ALL_CODES) {
      // unmapped codes fall back to the literal icon string, so a mapped code
      // never round-trips to itself
      expect(zaloToEmoji(code), `Reactions code "${code}" is unmapped`).not.toBe(code);
      expect(zaloToEmoji(code).length).toBeGreaterThan(0);
    }
  });

  it("falls back to the literal icon string for unknown codes (no fake ❤️)", () => {
    expect(zaloToEmoji("/-unknown-code")).toBe("/-unknown-code");
  });

  it("round-trips heart and like", () => {
    expect(zaloToEmoji(emojiToZalo("👍"))).toBe("👍");
    expect(zaloToEmoji(emojiToZalo("❤️"))).toBe("❤️");
  });
});
