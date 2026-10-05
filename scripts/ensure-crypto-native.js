// matrix-bot-sdk pins its own nested copy of @matrix-org/matrix-sdk-crypto-nodejs
// whose postinstall download is blocked by npm allowScripts. Copy the top-level
// native binding into every nested copy so require() resolves everywhere.
import { existsSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const top = path.dirname(require.resolve("@matrix-org/matrix-sdk-crypto-nodejs/package.json"));
const binding = existsSync(top) ? require("node:fs").readdirSync(top).find(f => f.endsWith(".node")) : undefined;
if (!binding) {
	console.warn("[ensure-crypto-native] no native binding found at", top);
	process.exit(0);
}
for (const nested of [
	path.join("node_modules", "@vector-im", "matrix-bot-sdk", "node_modules", "@matrix-org", "matrix-sdk-crypto-nodejs"),
]) {
	const target = path.join(process.cwd(), nested);
	if (target !== top && existsSync(target)) {
		copyFileSync(path.join(top, binding), path.join(target, binding));
		console.log(`[ensure-crypto-native] copied ${binding} -> ${nested}`);
	}
}
