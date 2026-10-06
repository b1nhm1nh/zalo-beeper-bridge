import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import Database from "better-sqlite3";

const [target = "Dean", limitArg = "10"] = process.argv.slice(2);
const limit = Number.parseInt(limitArg, 10) || 10;

const root = path.resolve(process.cwd());
const cfg = yaml.load(fs.readFileSync(path.join(root, "config.yaml"), "utf8")) as any;

const db = new Database(path.join(root, cfg.bridge?.dbPath || "bridge.db"));

const portal = db.prepare("SELECT thread_id, room_id, name FROM portal WHERE thread_id = ? OR name LIKE ?").get(target, `%${target}%`) as { thread_id: string; room_id: string; name: string } | undefined;

if (!portal) {
  console.error(`Error: No portal room found for target "${target}"`);
  process.exit(1);
}

const rows = db.prepare(`
  SELECT direction, ts, quote_json
  FROM message
  WHERE room_id = ?
  ORDER BY ts DESC
  LIMIT ?
`).all(portal.room_id, limit) as { direction: string; ts: number; quote_json: string }[];

console.log(`--- Conversation with ${portal.name || portal.thread_id} (${portal.thread_id}) ---`);
for (const row of rows.reverse()) {
  const d = new Date(row.ts);
  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let text = "";
  try {
    const data = JSON.parse(row.quote_json);
    text = data.content || data.title || "[Media/Attachment]";
  } catch {
    text = "[Message]";
  }
  const who = row.direction === "outbound" ? "You" : (portal.name || "Them");
  console.log(`[${timeStr}] ${who}: ${text}`);
}
