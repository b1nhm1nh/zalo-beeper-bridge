// Persist zca-js Credentials ({cookie, imei, userAgent}) encrypted at rest.
// A leaked plaintext session = full Zalo account takeover, so the file is
// AES-256-GCM encrypted. Two envelope versions:
//   ZBENC1 (legacy): key in a sibling 0600 key file — the key sits next to the
//     ciphertext, so a whole-directory leak defeats it. Still readable.
//   ZBENC2: key derived from ZALO_CREDS_PASSPHRASE via PBKDF2-SHA256 (100k iters,
//     random 16-byte salt stored in the envelope). Preferred.
// Legacy plaintext JSON files are transparently read and re-encrypted on next save;
// v1 files are likewise upgraded to v2 on the next save once a passphrase is set.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Credentials } from "zca-js";

const MAGIC_V1 = "ZBENC1"; // machine key file + static key (legacy)
const MAGIC_V2 = "ZBENC2"; // passphrase-derived key, salt in envelope
const PASSPHRASE_ENV = "ZALO_CREDS_PASSPHRASE";
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const KEY_BYTES = 32;
const FILE_MODE = 0o600;

function keyPathFor(credsPath: string): string {
  return path.join(path.dirname(credsPath), `.${path.basename(credsPath)}.key`);
}

function getPassphrase(): string | undefined {
  const value = process.env[PASSPHRASE_ENV];
  return value && value.length > 0 ? value : undefined;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_BYTES, "sha256");
}

function seal(plaintext: string, key: Buffer): { iv: Buffer; tag: Buffer; data: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

function encryptV1(plaintext: string, key: Buffer): string {
  const { iv, tag, data } = seal(plaintext, key);
  return `${MAGIC_V1}:${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

function encryptV2(plaintext: string, passphrase: string): string {
  const salt = crypto.randomBytes(PBKDF2_SALT_BYTES);
  const { iv, tag, data } = seal(plaintext, deriveKey(passphrase, salt));
  return `${MAGIC_V2}:${iv.toString("base64")}:${tag.toString("base64")}:${salt.toString("base64")}:${data.toString("base64")}`;
}

function openEnvelope(ivB64: string, tagB64: string, dataB64: string, key: Buffer): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** v1 layout: ZBENC1:iv:tag:data (no salt). */
function decryptV1(payload: string, key: Buffer): string {
  const [, ivB64, tagB64, dataB64] = payload.split(":");
  return openEnvelope(ivB64!, tagB64!, dataB64!, key);
}

/** v2 layout: ZBENC2:iv:tag:salt:data — the salt sits between tag and data. */
function decryptV2(payload: string, key: Buffer): string {
  const [, ivB64, tagB64, , dataB64] = payload.split(":");
  return openEnvelope(ivB64!, tagB64!, dataB64!, key);
}

/** Legacy machine key: random key in a sibling file, i.e. next to the ciphertext. */
function loadOrCreateKey(credsPath: string): Buffer {
  const keyPath = keyPathFor(credsPath);
  if (fs.existsSync(keyPath)) {
    const key = Buffer.from(fs.readFileSync(keyPath, "utf8"), "base64");
    fs.chmodSync(keyPath, FILE_MODE);
    return key;
  }
  const key = crypto.randomBytes(KEY_BYTES);
  const tmp = `${keyPath}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, key.toString("base64"), { mode: FILE_MODE });
  fs.renameSync(tmp, keyPath);
  fs.chmodSync(keyPath, FILE_MODE);
  return key;
}

let warnedNoPassphrase = false;
function warnNoPassphraseOnce(credsPath: string): void {
  if (warnedNoPassphrase) return;
  warnedNoPassphrase = true;
  console.warn(
    `[credential-store] ${PASSPHRASE_ENV} is not set — the AES key sits unencrypted next to the ciphertext at ${keyPathFor(credsPath)}; anyone who can read the directory can decrypt the session. Set ${PASSPHRASE_ENV} to derive the key from a passphrase instead.`,
  );
}

function warnWidePerms(credsPath: string): void {
  try {
    const mode = fs.statSync(credsPath).mode & 0o777;
    if (mode & 0o077) {
      console.warn(`[credential-store] credentials file ${credsPath} is mode ${mode.toString(8)} — tightening would be wise (expected 600)`);
    }
  } catch {
    // stat failing here would have failed above already
  }
}

export function loadCredentials(credsPath: string): Credentials | null {
  if (!fs.existsSync(credsPath)) return null;
  warnWidePerms(credsPath);
  const raw = fs.readFileSync(credsPath, "utf8");
  const passphrase = getPassphrase();
  try {
    if (raw.startsWith(`${MAGIC_V2}:`)) {
      if (!passphrase) {
        console.error(`[credential-store] ${credsPath} is passphrase-encrypted (${MAGIC_V2}) but ${PASSPHRASE_ENV} is not set — cannot decrypt`);
        return null;
      }
      const [, , , saltB64] = raw.split(":");
      const key = deriveKey(passphrase, Buffer.from(saltB64!, "base64"));
      return JSON.parse(decryptV2(raw, key)) as Credentials;
    }
    if (raw.startsWith(`${MAGIC_V1}:`)) {
      const creds = JSON.parse(decryptV1(raw, loadOrCreateKey(credsPath))) as Credentials;
      if (passphrase) console.log(`[credential-store] legacy ${MAGIC_V1} envelope detected — will upgrade to ${MAGIC_V2} on next save`);
      else warnNoPassphraseOnce(credsPath);
      return creds;
    }
    const creds = JSON.parse(raw) as Credentials; // legacy plaintext — re-encrypted on next save
    if (passphrase) console.log(`[credential-store] legacy plaintext credentials detected — will encrypt (${MAGIC_V2}) on next save`);
    else warnNoPassphraseOnce(credsPath);
    return creds;
  } catch {
    console.warn(`Corrupt or undecryptable credentials at ${credsPath} — ignoring`);
    return null;
  }
}

export function saveCredentials(credsPath: string, creds: Credentials): void {
  const json = JSON.stringify(creds);
  const passphrase = getPassphrase();
  // v2 (passphrase-derived, salted) when available; legacy key file otherwise.
  const payload = passphrase ? encryptV2(json, passphrase) : encryptV1(json, loadOrCreateKey(credsPath));
  const tmp = path.join(path.dirname(credsPath), `.${path.basename(credsPath)}.tmp`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, payload, { mode: FILE_MODE });
  fs.renameSync(tmp, credsPath);
  fs.chmodSync(credsPath, FILE_MODE); // mode only applies at creation — enforce on every save
  if (!passphrase) warnNoPassphraseOnce(credsPath);
}

export function clearCredentials(credsPath: string): void {
  fs.rmSync(credsPath, { force: true });
  fs.rmSync(keyPathFor(credsPath), { force: true });
}
