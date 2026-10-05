// Zalo uid → Matrix ghost (e.g. @sh-zalo_<uid>:domain): registration + displayname sync.
// The ghost prefix is derived from the bbctl registration (see deriveGhostPrefix) so
// ghosts always live inside the appservice's own user namespace.
import type { Bridge, Intent } from "matrix-appservice-bridge";
import { fetchMediaCapped } from "./media-handler.ts";
import type { MappingStore } from "./mapping-store.ts";

/** Historical prefix, kept as the fallback when no registration id is available. */
export const DEFAULT_GHOST_PREFIX = "sh-zalo_";

/**
 * Single source of truth for the ghost MXID prefix, derived from the appservice id
 * (bbctl registration "sh-zalo" / sender_localpart "sh-zalobot" → "sh-zalo_").
 * Falls back to the historical prefix only when the id is absent.
 */
export function deriveGhostPrefix(appServiceId: string | null | undefined): string {
  const id = appServiceId?.trim();
  if (!id) return DEFAULT_GHOST_PREFIX;
  // bbctl sender localparts carry a trailing "bot" (sh-zalobot); strip it so the
  // prefix matches the registration id, not the bot's localpart.
  return `${id.replace(/bot$/, "")}_`;
}

export type ProfileResolver = (uid: string) => Promise<{ displayName?: string; avatarUrl?: string } | null>;

export class PuppetRegistry {
  private readonly bridge: Bridge;
  private readonly store: MappingStore;
  private readonly domain: string;
  private readonly resolveProfile?: ProfileResolver;
  private readonly registered = new Set<string>();
  /** Derived once from the registration id — every MXID builds on this. */
  readonly ghostPrefix: string;

  constructor(bridge: Bridge, store: MappingStore, domain: string, resolveProfile?: ProfileResolver, appServiceId?: string | null) {
    this.bridge = bridge;
    this.store = store;
    this.domain = domain;
    this.resolveProfile = resolveProfile;
    this.ghostPrefix = deriveGhostPrefix(appServiceId);
  }

  mxidFor(zaloUid: string): string {
    return `@${this.ghostPrefix}${zaloUid}:${this.domain}`;
  }

  intentFor(zaloUid: string): Intent {
    return this.bridge.getIntent(this.mxidFor(zaloUid));
  }

  /** Ensures the ghost exists and its displayname tracks the Zalo contact name. */
  async ensurePuppet(zaloUid: string, displayName?: string): Promise<Intent> {
    const mxid = this.mxidFor(zaloUid);
    const intent = this.bridge.getIntent(mxid);
    if (!this.registered.has(mxid)) {
      await intent.ensureRegistered();
      this.registered.add(mxid);
    }
    const nameChanged = this.store.upsertPuppet(zaloUid, mxid, displayName ?? null);
    if (nameChanged && displayName) {
      await intent.setDisplayName(displayName).catch((err: Error) => console.warn(`setDisplayName(${mxid}) failed:`, err.message));
    }
    // Avatar: synced once per puppet (Zalo avatars change rarely; re-sync is a later concern)
    if (this.resolveProfile && this.store.getPuppetAvatarUrl(zaloUid) === null) {
      await this.syncAvatar(zaloUid, intent).catch((err: Error) => console.warn(`avatar sync(${mxid}) failed:`, err.message));
    }
    return intent;
  }

  private async syncAvatar(zaloUid: string, intent: Intent): Promise<void> {
    const profile = await this.resolveProfile!(zaloUid);
    if (!profile?.avatarUrl) return;
    const { buffer, mimetype } = await fetchMediaCapped(profile.avatarUrl, 5 * 1024 * 1024);
    const mxc = await intent.uploadContent(buffer, { type: mimetype, name: "zalo-avatar" });
    await intent.setAvatarUrl(mxc);
    this.store.setPuppetAvatarUrl(zaloUid, profile.avatarUrl);
  }
}

/** Startup guard: computed ghost MXIDs must fall inside the appservice namespace. */
export function assertGhostNamespace(usersRegex: string, sampleMxid: string): void {
  if (!new RegExp(usersRegex).test(sampleMxid)) {
    throw new Error(`Ghost MXID ${sampleMxid} does not match registration namespace regex ${usersRegex} — check registration.yaml`);
  }
}
