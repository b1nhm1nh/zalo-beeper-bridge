import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCredentials, loadCredentials, saveCredentials } from "../credential-store.ts";
import type { Credentials } from "zca-js";

const CREDS = {
  imei: "imei-123",
  cookie: [{ domain: ".zalo.me", name: "session", value: "super-secret", path: "/" }],
  userAgent: "Mozilla/5.0 test",
} as unknown as Credentials;

let dir: string;
let credsPath: string;

function fileMode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

/** Rebuilds the pre-v2 envelope: AES-256-GCM with a sibling 0600 key file. */
function writeLegacyV1(creds: object): void {
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(dir, ".zalo-creds.json.key"), key.toString("base64"));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(creds), "utf8"), cipher.final()]);
  fs.writeFileSync(credsPath, `ZBENC1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`);
}

function saltB64Of(payload: string): string {
  const parts = payload.split(":");
  return parts[3]!; // ZBENC2:iv:tag:salt:data
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-test-"));
  credsPath = path.join(dir, "zalo-creds.json");
  delete process.env.ZALO_CREDS_PASSPHRASE;
});

afterEach(() => {
  delete process.env.ZALO_CREDS_PASSPHRASE;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("credential-store v2 envelope (passphrase)", () => {
  it("round-trips credentials through a passphrase-derived envelope", () => {
    process.env.ZALO_CREDS_PASSPHRASE = "correct horse battery staple";
    saveCredentials(credsPath, CREDS);
    const raw = fs.readFileSync(credsPath, "utf8");
    expect(raw.startsWith("ZBENC2:")).toBe(true);
    expect(raw.split(":")).toHaveLength(5); // magic:iv:tag:salt:data — salt travels in the envelope
    expect(loadCredentials(credsPath)).toEqual(CREDS);
  });

  it("uses a fresh random salt on every save", () => {
    process.env.ZALO_CREDS_PASSPHRASE = "another pass";
    saveCredentials(credsPath, CREDS);
    const first = saltB64Of(fs.readFileSync(credsPath, "utf8"));
    saveCredentials(credsPath, CREDS);
    const second = saltB64Of(fs.readFileSync(credsPath, "utf8"));
    expect(first).not.toBe(second);
  });

  it("rejects a passphrase envelope when no passphrase is configured (fails closed)", () => {
    process.env.ZALO_CREDS_PASSPHRASE = "p";
    saveCredentials(credsPath, CREDS);
    delete process.env.ZALO_CREDS_PASSPHRASE;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadCredentials(credsPath)).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("ZALO_CREDS_PASSPHRASE"));
  });
});

describe("credential-store legacy formats", () => {
  it("reads legacy plaintext JSON", () => {
    fs.writeFileSync(credsPath, JSON.stringify(CREDS));
    expect(loadCredentials(credsPath)).toEqual(CREDS);
  });

  it("reads the legacy v1 envelope via the machine key file (no passphrase)", () => {
    writeLegacyV1(CREDS);
    expect(loadCredentials(credsPath)).toEqual(CREDS);
  });

  it("reads legacy v1 with a passphrase set and upgrades to v2 on next save", () => {
    writeLegacyV1(CREDS);
    process.env.ZALO_CREDS_PASSPHRASE = "upgrade pass";
    expect(loadCredentials(credsPath)).toEqual(CREDS); // still readable pre-upgrade
    saveCredentials(credsPath, CREDS);
    expect(fs.readFileSync(credsPath, "utf8").startsWith("ZBENC2:")).toBe(true);
    expect(loadCredentials(credsPath)).toEqual(CREDS);
  });

  it("upgrades legacy plaintext to v2 on next save", () => {
    fs.writeFileSync(credsPath, JSON.stringify(CREDS));
    process.env.ZALO_CREDS_PASSPHRASE = "p";
    expect(loadCredentials(credsPath)).toEqual(CREDS);
    saveCredentials(credsPath, CREDS);
    expect(fs.readFileSync(credsPath, "utf8").startsWith("ZBENC2:")).toBe(true);
  });
});

describe("credential-store permissions and warnings", () => {
  describe.skipIf(process.platform === "win32")("posix modes", () => {
    it("enforces 0600 on the creds file after save", () => {
      fs.writeFileSync(credsPath, "wide", { mode: 0o644 }); // simulate a previously-loose file
      process.env.ZALO_CREDS_PASSPHRASE = "p";
      saveCredentials(credsPath, CREDS);
      expect(fileMode(credsPath)).toBe(0o600);
    });

    it("creates the legacy key file owner-only", () => {
      saveCredentials(credsPath, CREDS); // no passphrase → key file created
      expect(fileMode(path.join(dir, ".zalo-creds.json.key"))).toBe(0o600);
    });
  });

  it("warns when the creds file is readable by other users", () => {
    fs.writeFileSync(credsPath, JSON.stringify(CREDS), { mode: 0o644 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadCredentials(credsPath)).toEqual(CREDS);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/mode 644/));
  });

  it("warns once that the AES key sits next to the ciphertext when no passphrase is set", async () => {
    fs.writeFileSync(credsPath, JSON.stringify(CREDS));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Fresh module instance: the once-per-process warning flag is module state
    vi.resetModules();
    const fresh = await import("../credential-store.ts");
    fresh.loadCredentials(credsPath);
    fresh.loadCredentials(credsPath);
    const calls = warnSpy.mock.calls.filter((args) => String(args[0]).includes("ZALO_CREDS_PASSPHRASE"));
    expect(calls).toHaveLength(1); // once per process, not once per load
    expect(String(calls[0]?.[0])).toMatch(/next to the ciphertext/);
  });
});

describe("clearCredentials", () => {
  it("removes the creds file and the legacy key file", () => {
    process.env.ZALO_CREDS_PASSPHRASE = "p";
    saveCredentials(credsPath, CREDS);
    clearCredentials(credsPath);
    expect(fs.existsSync(credsPath)).toBe(false);
    expect(fs.existsSync(path.join(dir, ".zalo-creds.json.key"))).toBe(false);
    expect(loadCredentials(credsPath)).toBeNull();
  });
});
