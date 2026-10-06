import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import Database from "better-sqlite3";

const [target, ...msgParts] = process.argv.slice(2);
const message = msgParts.join(" ").trim();

if (!target || !message) {
  console.log("Usage: node bin/send.ts <threadId|name> <message>");
  console.log("Example: node bin/send.ts Dean \"hello\"");
  process.exit(1);
}

const root = path.resolve(process.cwd());
const cfg = yaml.load(fs.readFileSync(path.join(root, "config.yaml"), "utf8")) as any;
const reg = yaml.load(fs.readFileSync(path.join(root, "registration.yaml"), "utf8")) as any;

const db = new Database(path.join(root, cfg.bridge?.dbPath || "bridge.db"));

const portal = db.prepare("SELECT thread_id, room_id, name FROM portal WHERE thread_id = ? OR name LIKE ?").get(target, `%${target}%`) as { thread_id: string; room_id: string; name: string } | undefined;

if (!portal) {
  console.error(`Error: No portal room found for target "${target}"`);
  process.exit(1);
}

const hs = cfg.matrix.homeserverUrl;
const owner = cfg.matrix.owner;
const asToken = reg.as_token;
const txnId = "cli_" + Date.now();

const url = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(portal.room_id)}/send/m.room.message/${txnId}?user_id=${encodeURIComponent(owner)}&access_token=${asToken}`;

const res = await fetch(url, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    msgtype: "m.text",
    body: message,
  }),
});

if (res.ok) {
  const data = await res.json() as { event_id: string };
  console.log(`✓ Sent to ${portal.name || portal.thread_id} via Zalo: "${message}" (${data.event_id})`);
} else {
  console.error(`Failed to send (HTTP ${res.status}):`, await res.text());
  process.exit(1);
}
