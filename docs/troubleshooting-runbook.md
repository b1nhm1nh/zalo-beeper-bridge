# Troubleshooting Runbook

Quick checks: `launchctl list | grep beeper-zalo` (both should show exit 0), `tail -f logs/bridge.log`.

Both launchd jobs log into `logs/` inside the repo. The bridge creates that directory on boot; if `launchctl` refuses to start the jobs on a fresh clone, run `mkdir -p logs` once — launchd opens `logs/*.log` before the process runs. The plists in `deploy/launchd/` ship with `REPLACE_WITH_*` placeholders and must be edited to your absolute paths before loading.

## Bot commands don't respond

Bot commands (`ping`, `login`, `logout`, `status`, `sync`) are accepted **only from `matrix.owner`** in `config.yaml` — your full Beeper Matrix ID, e.g. `@you:beeper.com`. Messages from any other user are ignored by design (single-user bridge). Also check the management chat is a DM with the bridge bot (`@sh-zalobot:beeper.local`).

## Messages stop flowing / listener not connected

`logs/bridge.log` shows reconnecting or a `dead` message.

- **You opened Zalo Web in a browser.** Zalo allows one web session; it kicked the bridge. Close Zalo Web; the listener auto-reconnects (backoff up to 5 min). Use the phone app alongside the bridge, not Zalo Web.
- **Cookie/session expired.** Send `login` to the bot in Beeper and scan the QR again.
- **`[zalo] listener DEAD`.** Session unusable — send `login` to re-authenticate. Beeper shows the account as **DISCONNECTED** (not BAD_CREDENTIALS): a dead listener only means the socket gave up retrying, so the saved cookies are usually still valid and a needless QR relogin is not forced.

## Bridge account states (network chip)

The bridge publishes the Zalo account's remote state to Beeper (`bbctl whoami --raw` → `bridges.sh-zalo.remoteState`) and keeps it fresh with a 10-minute heartbeat:

| State | Meaning |
|-------|---------|
| `CONNECTED` | logged in and the Zalo listener is alive |
| `TRANSIENT_DISCONNECT` | listener reconnecting with backoff |
| `DISCONNECTED` | listener gave up (kicked, repeated closes) or was stopped |
| `LOGGED_OUT` | you ran `logout` (includes the reason) |

## Bridge shows UNCONFIGURED after proxy restart

`bbctl proxy` owns the bridge-level state and resets it to `UNCONFIGURED` when it restarts; nothing on Beeper's side restores it. The bridge detects the proxy coming back (first appservice transaction after a ≥60s quiet gap) and immediately re-asserts `RUNNING` plus the current remote state; the heartbeat also re-asserts `RUNNING` every 10 minutes even when no traffic flows. If the network still shows as unreachable after a proxy restart, wait for the next inbound message or heartbeat, and check `logs/bridge.log` for `appservice traffic resumed after a gap`.

## "Suspected ban" / account locked

If Zalo throttles or locks the account, sends fail and the log shows repeated auth errors. Stop the bridge (`launchctl unload …`), log into Zalo normally on your phone to clear any security prompt, then reload. Lower `messagesPerMinute`/`burst` in `config.yaml` if it recurs.

## Images / media won't send

- Check `logs/bridge.log` for `Failed to send … to Zalo`.
- Media over the size cap (`bridge.mediaMaxBytes`, default 10 MB) is rejected — raise the cap or send smaller.
- Voice notes are delivered as file attachments (Zalo's native voice bubble needs a URL the bridge can't provide).

## Recall didn't reach Zalo

Only messages **you sent from Beeper** can be recalled (Zalo only lets you recall your own), and only within Zalo's recall time window. Recalling someone else's message does nothing on Zalo.

## Bridge won't start (launchd exit code non-zero)

- `launchctl list | grep beeper-zalo` shows a non-zero exit code.
- Check `logs/bridge.log` for the stack. Common causes: `config.yaml` missing/invalid (copy from `config.yaml.example`), wrong Node path in the plist (update after an nvm upgrade), or `registration.yaml` missing (`bbctl register sh-zalo`).

## Upgrading zca-js

Zalo Web changes can break zca-js. When bumping the pinned version: `npm test` (normalizer fixtures), then a manual smoke test (send/receive text + image). All zca-js usage is isolated in `src/zalo/zalo-client.ts`.

## Network name still shows "sh-zalo"

The bot profile is "Zalo" and portals carry the network branding, but the top-level network label is fixed to the bbctl registration name. Renaming it is not supported from a custom appservice (see the investigation report under `plans/.../reports/`).
