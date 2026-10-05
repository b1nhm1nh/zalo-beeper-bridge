import { afterEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "matrix-appservice-bridge";
import { bridgeInboundSticker, downloadMatrixMedia, fetchMediaCapped } from "../media-handler.ts";

const PNG = new TextEncoder().encode("png-bytes");

/** Minimal fetch Response stand-in: ok/status/headers.get + async-iterable body with cancel(). */
function fakeResponse(status: number, headers: Record<string, string> = {}, chunks: Uint8Array[] = [PNG]): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
      cancel: async () => {},
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchMediaCapped", () => {
  it("rejects non-https first hops without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMediaCapped("http://media.zdn.vn/a.png", 100)).rejects.toThrow(/non-http\(s\)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects first hops outside the Zalo CDN allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMediaCapped("https://169.254.169.254/latest/meta-data/", 100)).rejects.toThrow(/outside Zalo CDN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a redirect to a non-allowlisted host without fetching it (SSRF)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(302, { location: "https://169.254.169.254/latest/meta-data/" }))
      .mockResolvedValue(fakeResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMediaCapped("https://media.zdn.vn/shorten/1", 1000)).rejects.toThrow(/outside Zalo CDN/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the metadata host was never contacted
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://media.zdn.vn/shorten/1");
  });

  it("rejects redirects to non-http(s) schemes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(302, { location: "file:///etc/passwd" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMediaCapped("https://media.zdn.vn/shorten/2", 1000)).rejects.toThrow(/non-http\(s\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows an allowlisted redirect chain and returns the body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(302, { location: "https://cdn2.zadn.vn/real.png" }))
      .mockResolvedValue(fakeResponse(200, { "content-type": "image/png" }));
    vi.stubGlobal("fetch", fetchMock);
    const media = await fetchMediaCapped("https://media.zdn.vn/shorten/3", 1000);
    expect(media.mimetype).toBe("image/png");
    expect(media.buffer.toString()).toBe("png-bytes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://cdn2.zadn.vn/real.png");
  });

  it("caps redirect hops", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => fakeResponse(302, { location: "https://a.zdn.vn/loop" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMediaCapped("https://media.zdn.vn/loop0", 1000)).rejects.toThrow(/too many media redirects/);
    expect(fetchMock).toHaveBeenCalledTimes(6); // initial request + 5 allowed hops
  });

  it("enforces the byte cap after redirects", async () => {
    const big = new TextEncoder().encode("x".repeat(500));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(302, { location: "https://cdn.zadn.vn/big.png" }))
      .mockResolvedValue(fakeResponse(200, { "content-type": "image/png" }, [big]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMediaCapped("https://media.zdn.vn/shorten/4", 100)).rejects.toThrow(/size cap/);
  });
});

describe("downloadMatrixMedia", () => {
  it("percent-encodes the server name and media id into the download URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { "content-type": "image/png" }));
    vi.stubGlobal("fetch", fetchMock);
    await downloadMatrixMedia("https://hs.example.com", "token", "mxc://hs.example.com/Abc/def?x=1#frag", 1000);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://hs.example.com/_matrix/client/v1/media/download/hs.example.com/Abc%2Fdef%3Fx%3D1%23frag",
    );
  });

  it("rejects malformed mxc urls without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadMatrixMedia("https://hs.example.com", "token", "https://not-an-mxc-url", 1000)).rejects.toThrow(/bad mxc/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the byte cap", async () => {
    const big = new TextEncoder().encode("y".repeat(300));
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { "content-type": "image/png" }, [big]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadMatrixMedia("https://hs.example.com", "token", "mxc://hs.example.com/abc", 100)).rejects.toThrow(/size cap/);
  });
});

describe("sticker mxc cache bound", () => {
  it("evicts oldest entries past the cap and keeps recent ones", async () => {
    const uploadContent = vi.fn(async (_buf: Buffer, opts?: { name?: string }) => `mxc://beeper.local/${opts?.name}`);
    const sendEvent = vi.fn(async () => ({ event_id: "$sticker" }));
    const intent = { uploadContent, sendEvent } as unknown as Intent;
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(200, { "content-type": "image/png" })));

    for (let id = 1; id <= 250; id++) {
      await bridgeInboundSticker(intent, "!r:x", id, `https://media.zdn.vn/s/${id}.png`, 1000);
    }
    expect(uploadContent).toHaveBeenCalledTimes(250);

    // sticker 1 fell out of the bounded cache → downloaded + uploaded again
    await bridgeInboundSticker(intent, "!r:x", 1, "https://media.zdn.vn/s/1.png", 1000);
    expect(uploadContent).toHaveBeenCalledTimes(251);

    // the most recently used sticker is still cached → no new upload
    await bridgeInboundSticker(intent, "!r:x", 250, "https://media.zdn.vn/s/250.png", 1000);
    expect(uploadContent).toHaveBeenCalledTimes(251);
  });
});
