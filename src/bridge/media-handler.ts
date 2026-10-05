// Inbound media pipeline: Zalo CDN URL → download → Matrix content repo → m.image.
// Phase 1 verified the CDN is public (no session headers), but URLs may expire —
// always download immediately on event receipt.
import type { Intent } from "matrix-appservice-bridge";

export interface InboundPhoto {
  url: string;
  width?: number;
  height?: number;
  caption?: string;
}

export interface MediaResult {
  eventId: string;
}

const FETCH_TIMEOUT_MS = 30_000;
// Media URLs come from message payloads (contact-influenced input) — restrict
// to Zalo CDN hosts over https to close SSRF toward localhost/LAN.
const ALLOWED_HOST_SUFFIXES = [".zdn.vn", ".zadn.vn"];
// Redirects are followed manually so EVERY hop's host is re-validated against the
// allowlist — auto-follow would let a Zalo-controlled shortener bounce the bridge
// onto arbitrary hosts (cloud metadata, localhost).
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchedMedia {
  buffer: Buffer;
  mimetype: string;
}

function isAllowedMediaHost(hostname: string): boolean {
  return ALLOWED_HOST_SUFFIXES.some((s) => hostname.endsWith(s));
}

/**
 * Every hop of a media fetch must land on the Zalo CDN allowlist. The first hop
 * keeps the original https-only rule; redirect hops may downgrade to http (still
 * allowlisted hosts) but never to a non-http(s) scheme.
 */
function validateMediaHop(url: URL, isFirstHop: boolean): void {
  const schemeOk = url.protocol === "https:" || (!isFirstHop && url.protocol === "http:");
  if (!schemeOk) throw new Error(`refusing non-http(s) media URL (${url.protocol})`);
  if (!isAllowedMediaHost(url.hostname)) {
    throw new Error(`refusing media host outside Zalo CDN (${url.hostname})`);
  }
}

/** Stream a response body with a hard byte cap — content-length can be spoofed. */
async function collectCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`media exceeds size cap (>${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Download Matrix media (mxc://) via the authenticated media endpoint.
 * Beeper serves media behind auth + a redirect to R2; matrix-bot-sdk's
 * downloadContent forwards the Authorization header to R2 and gets a 400.
 * Native fetch strips auth on the cross-origin redirect, so it works.
 * The server name and media id are percent-encoded — a crafted media id must not
 * be able to inject path/query segments into the homeserver URL.
 */
export async function downloadMatrixMedia(
  homeserverUrl: string,
  accessToken: string,
  mxcUrl: string,
  maxBytes: number,
): Promise<FetchedMedia> {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUrl);
  if (!match) throw new Error(`bad mxc url: ${mxcUrl}`);
  const [, server, mediaId] = match; // both groups always match when the regex does
  const url = `${homeserverUrl}/_matrix/client/v1/media/download/${encodeURIComponent(server!)}/${encodeURIComponent(mediaId!)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`matrix media download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("matrix media download returned no body");
  return {
    buffer: await collectCapped(response.body as AsyncIterable<Uint8Array>, maxBytes),
    mimetype: response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
  };
}

/** Guarded download: https-only first hop, Zalo CDN hosts on EVERY hop, hard timeout, streamed byte cap. */
export async function fetchMediaCapped(url: string, maxBytes: number): Promise<FetchedMedia> {
  let current = new URL(url);
  validateMediaHop(current, true);

  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECT_HOPS) throw new Error(`too many media redirects (>${MAX_REDIRECT_HOPS})`);
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      try {
        await response.body?.cancel(); // release the socket; redirect bodies are never read
      } catch {
        // draining the redirect body is best-effort
      }
      if (!location) throw new Error(`media redirect ${response.status} without Location header`);
      const next = new URL(location, current); // relative Locations resolve against the current hop
      validateMediaHop(next, false); // re-validate BEFORE fetching — never touch an unvalidated host
      current = next;
      continue;
    }

    if (!response.ok) throw new Error(`media download failed: HTTP ${response.status}`);
    if (!response.body) throw new Error("media download returned no body");
    return {
      buffer: await collectCapped(response.body as AsyncIterable<Uint8Array>, maxBytes),
      mimetype: response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
    };
  }
}

// Sticker mxc cache — the same sticker id is sent many times; upload once per run.
// Bounded because the bridge process runs for months and sticker ids are
// contact-influenced unbounded input: insertion-order eviction past the cap.
const STICKER_CACHE_MAX_ENTRIES = 200;
type StickerMxc = { mxc: string; mimetype: string; size: number };
const stickerMxcCache = new Map<number, StickerMxc>();

function rememberSticker(stickerId: number, entry: StickerMxc): void {
  stickerMxcCache.delete(stickerId); // re-insert at newest position on refresh
  stickerMxcCache.set(stickerId, entry);
  while (stickerMxcCache.size > STICKER_CACHE_MAX_ENTRIES) {
    const oldest = stickerMxcCache.keys().next();
    if (oldest.done) break;
    stickerMxcCache.delete(oldest.value);
  }
}

/** Renders a Zalo sticker as a native Matrix m.sticker event. */
export async function bridgeInboundSticker(
  intent: Intent,
  roomId: string,
  stickerId: number,
  imageUrl: string,
  maxBytes: number,
  extra?: Record<string, unknown>,
): Promise<MediaResult> {
  let cached = stickerMxcCache.get(stickerId);
  if (!cached) {
    const { buffer, mimetype } = await fetchMediaCapped(imageUrl, maxBytes);
    const mxc = await intent.uploadContent(buffer, { type: mimetype, name: `zalo-sticker-${stickerId}` });
    cached = { mxc, mimetype, size: buffer.byteLength };
    rememberSticker(stickerId, cached);
  }
  const { event_id } = await intent.sendEvent(roomId, "m.sticker", {
    body: "sticker",
    url: cached.mxc,
    info: { mimetype: cached.mimetype, size: cached.size },
    ...extra,
  });
  return { eventId: event_id };
}

export async function bridgeInboundPhoto(
  intent: Intent,
  roomId: string,
  photo: InboundPhoto,
  maxBytes: number,
  extra?: Record<string, unknown>,
): Promise<MediaResult> {
  const { buffer, mimetype } = await fetchMediaCapped(photo.url, maxBytes);
  const ext = mimetype.split("/")[1]?.split(";")[0] ?? "jpg";
  const mxcUrl = await intent.uploadContent(buffer, { type: mimetype, name: `zalo-photo.${ext}` });
  // MSC2530 caption: body = caption, filename = the actual file name (kept distinct)
  const content: Record<string, unknown> = {
    msgtype: "m.image",
    body: photo.caption || `zalo-photo.${ext}`,
    url: mxcUrl,
    info: {
      mimetype,
      size: buffer.byteLength,
      ...(photo.width ? { w: photo.width } : {}),
      ...(photo.height ? { h: photo.height } : {}),
    },
  };
  if (photo.caption) content.filename = `zalo-photo.${ext}`;
  Object.assign(content, extra);
  const { event_id } = await intent.sendMessage(roomId, content);
  return { eventId: event_id };
}
