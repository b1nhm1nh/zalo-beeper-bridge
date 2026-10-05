// Maps between Matrix reaction emoji (unicode) and Zalo reaction icon codes.
// Zalo has a fixed palette; unmapped emoji fall back to the closest / HEART.
import { Reactions } from "zca-js";

// Unicode emoji → Zalo icon code
const EMOJI_TO_ZALO: Record<string, Reactions> = {
  "❤️": Reactions.HEART,
  "❤": Reactions.HEART,
  "👍": Reactions.LIKE,
  "😆": Reactions.HAHA,
  "😂": Reactions.TEARS_OF_JOY,
  "😮": Reactions.WOW,
  "😢": Reactions.CRY,
  "😠": Reactions.ANGRY,
  "😡": Reactions.ANGRY,
  "😘": Reactions.KISS,
  "🌹": Reactions.ROSE,
  "💔": Reactions.BROKEN_HEART,
  "👎": Reactions.DISLIKE,
};

// Zalo icon code → unicode emoji (for inbound rendering).
// Covers every Reactions enum value except NONE (""); anything unmapped
// falls through to the literal icon string so the reaction is never lost.
const ZALO_TO_EMOJI: Record<string, string> = {
  [Reactions.HEART]: "❤️",
  [Reactions.LIKE]: "👍",
  [Reactions.HAHA]: "😆",
  [Reactions.TEARS_OF_JOY]: "😂",
  [Reactions.WOW]: "😮",
  [Reactions.CRY]: "😢",
  [Reactions.ANGRY]: "😠",
  [Reactions.KISS]: "😘",
  [Reactions.SHIT]: "💩",
  [Reactions.ROSE]: "🌹",
  [Reactions.BROKEN_HEART]: "💔",
  [Reactions.DISLIKE]: "👎",
  [Reactions.LOVE]: "😍",
  [Reactions.CONFUSED]: "😕",
  [Reactions.WINK]: "😉",
  [Reactions.FADE]: "😪",
  [Reactions.SUN]: "☀️",
  [Reactions.BIRTHDAY]: "🎂",
  [Reactions.BOMB]: "💣",
  [Reactions.OK]: "👌",
  [Reactions.PEACE]: "✌️",
  [Reactions.THANKS]: "🙏",
  [Reactions.PUNCH]: "👊",
  [Reactions.SHARE]: "🤝",
  [Reactions.PRAY]: "🙏",
  [Reactions.NO]: "🙅",
  [Reactions.BAD]: "👎",
  [Reactions.LOVE_YOU]: "🥰",
  [Reactions.SAD]: "😞",
  [Reactions.VERY_SAD]: "😭",
  [Reactions.COOL]: "😎",
  [Reactions.NERD]: "🤓",
  [Reactions.BIG_SMILE]: "😄",
  [Reactions.SUNGLASSES]: "😎",
  [Reactions.NEUTRAL]: "😐",
  [Reactions.SAD_FACE]: "☹️",
  [Reactions.BYE]: "👋",
  [Reactions.SLEEPY]: "😴",
  [Reactions.WIPE]: "😥",
  [Reactions.DIG]: "💰",
  [Reactions.ANGUISH]: "😧",
  [Reactions.HANDCLAP]: "👏",
  [Reactions.ANGRY_FACE]: "😡",
  [Reactions.F_CHAIR]: "😂",
  [Reactions.L_CHAIR]: "🪑",
  [Reactions.R_CHAIR]: "🪑",
  [Reactions.SILENT]: "🤐",
  [Reactions.SURPRISE]: "😲",
  [Reactions.EMBARRASSED]: "😳",
  [Reactions.AFRAID]: "😨",
  [Reactions.SAD2]: "🙁",
  [Reactions.BIG_LAUGH]: "😆",
  [Reactions.RICH]: "🤑",
  [Reactions.BEER]: "🍺",
};

export function emojiToZalo(emoji: string): Reactions {
  return EMOJI_TO_ZALO[emoji] ?? Reactions.HEART;
}

export function zaloToEmoji(icon: string): string {
  return ZALO_TO_EMOJI[icon] ?? icon;
}
