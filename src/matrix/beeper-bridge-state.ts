// Beeper renders a bridge as a chat network only when its *remote account* state is
// published (visible as `bridges.<id>.remoteState` in `bbctl whoami --raw`). `bbctl proxy`
// publishes the bridge-level state (STARTING/RUNNING/BRIDGE_UNREACHABLE) on our behalf,
// but the per-account state is the bridge's own job. With it missing, newer Beeper clients
// hide the network chip and every chat filed under it, while older clients still render
// them from the local index — which is why the same account looks different per device.
//
// Two distinct endpoints, easy to confuse:
//   POST .../bridge/<id>/bridge_state         camelCase `stateEvent`, bridge-level states only
//   POST .../bridge/<id>/bridge_remote_state  snake_case `state_event`, per-account states  ← this one
//
// The remote state is an explicit observe→publish state machine:
//   - every publish derives from the CURRENT login + listener snapshot (never a stale
//     cache — the old heartbeat kept reposting CONNECTED long after logout);
//   - event-driven callers publish transitions only (changed-state dedupe);
//   - the heartbeat republishes the currently observed state each tick, which refreshes
//     the server's staleness clock (Beeper expires an unrefreshed state after a few hours)
//     and doubles as the retry for a failed publish (at most one attempt per tick).

const BEEPER_API_BASE = "https://api.beeper.com";

/** Beeper hungryserv URLs embed the account name: https://matrix.beeper.com/_hungryserv/<username> */
const HUNGRYSERV_USERNAME = /\/_hungryserv\/([^/?#]+)/;

export type RemoteStateEvent =
  | "CONNECTED"
  | "TRANSIENT_DISCONNECT"
  | "DISCONNECTED"
  | "BAD_CREDENTIALS"
  | "LOGGED_OUT"
  | "UNKNOWN_ERROR";

export interface RemoteState {
  state_event: RemoteStateEvent;
  /** Zalo uid — the key Beeper files the account under */
  remote_id: string;
  remote_name?: string;
  remote_profile?: { name?: string; avatar?: string };
  /** Human-readable cause (LOGGED_OUT/DISCONNECTED); extra fields are accepted by the API. */
  reason?: string;
}

/**
 * Publishes one remote-account state. Never throws; resolves `true` when the POST was
 * accepted (or when there is nothing to do, e.g. a non-Beeper homeserver) and `false`
 * when it failed — a failed publish must be retried by the next heartbeat tick.
 */
export type RemoteStateReporter = (state: RemoteState) => Promise<boolean>;

/** Bridge-level state reporter (`bridge_state` endpoint, camelCase `stateEvent`). */
export type BridgeStateEvent = "STARTING" | "RUNNING";
export type BridgeStateReporter = (stateEvent: BridgeStateEvent) => Promise<boolean>;

/** Profile lookups go through zca-js and can hang; past this we publish with a plain label. */
const PROFILE_LOOKUP_TIMEOUT_MS = 5_000;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
// Beeper expires a remote state that goes unrefreshed for a few hours even while the Zalo
// listener stays connected the whole time (confirmed empirically: one state_event transition
// at startup, no further transitions for 3h+, remoteState came back empty on next check).
// Re-post the observed state periodically so a long-idle connection doesn't go stale.
const HEARTBEAT_MS = 10 * 60 * 1000;
/** One-shot retry when CONNECTED went out without a profile (lookup timed out). */
const PROFILE_RETRY_MS = 60_000;

/** Current login/listener truth — read fresh on every publish and heartbeat tick. */
export interface ZaloRuntimeSnapshot {
  loggedIn: boolean;
  ownId: string | null;
  listener: "stopped" | "connected" | "reconnecting" | "dead";
}

interface ObservedState {
  state_event: RemoteStateEvent;
  reason?: string;
}

export interface ZaloStatePublisherDeps {
  homeserverUrl: string;
  /** appservice id, e.g. "sh-zalo" */
  bridgeId: string;
  asToken: string;
  /** account label when the Zalo profile is unavailable */
  fallbackName: string;
  /** Fresh login/listener truth, consulted on every publish and heartbeat tick. */
  getSnapshot: () => ZaloRuntimeSnapshot;
  getOwnProfile: (uid: string) => Promise<{ displayName?: string; avatarUrl?: string } | null>;
  /** Zalo CDN links are signed and expire — Beeper needs the avatar re-hosted as mxc:// */
  uploadAvatar: (zaloAvatarUrl: string) => Promise<string | undefined>;
  /** Injectable for tests; defaults to the real Beeper API reporter (no-op elsewhere). */
  reporter?: RemoteStateReporter;
  bridgeStateReporter?: BridgeStateReporter;
}

export interface ZaloStateMachine {
  /** Derive the observed state from the current snapshot; publish only on a transition. */
  publishIfChanged(): Promise<void>;
  /** Publish the observed state even when unchanged (heartbeat refresh, reconnects). */
  republish(): Promise<void>;
  /** Explicit logout: forces a LOGGED_OUT publish (with reason) for the last known account. */
  loggedOut(reason: string): Promise<void>;
  /** bbctl proxy traffic resumed after a gap: re-assert bridge RUNNING + the remote state. */
  onProxyReconnected(): Promise<void>;
}

/**
 * Publishes the Zalo account's state to Beeper and keeps it alive:
 * transitions are published deduped, the heartbeat republishes the currently observed
 * state each tick so a long-idle connection (no transitions) doesn't expire server-side,
 * and a CONNECTED that went out without a profile gets one retry with the profile.
 */
export function createZaloStateMachine(deps: ZaloStatePublisherDeps): ZaloStateMachine {
  const report = deps.reporter ?? createRemoteStateReporter(deps.homeserverUrl, deps.bridgeId, deps.asToken);
  const reportBridgeState = deps.bridgeStateReporter ?? createBridgeStateReporter(deps.homeserverUrl, deps.bridgeId, deps.asToken);

  let lastPublishedKey: string | null = null;
  /** Logout needs a remote_id to file the state under — remember the last one we saw. */
  let lastKnownOwnId: string | null = null;
  let loggedOutReason: string | null = null;
  let profileRetryTimer: NodeJS.Timeout | null = null;
  // State events fire in quick bursts (reconnecting → connected); serialize publishes so
  // the dedupe key and the profile retry observe a consistent order.
  let publishChain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = publishChain.then(task, task);
    publishChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const rememberLogin = (snapshot: ZaloRuntimeSnapshot): void => {
    if (snapshot.ownId) {
      lastKnownOwnId = snapshot.ownId;
      loggedOutReason = null; // logged back in
    }
  };

  /** The one place that maps login+listener truth → a Beeper remote state. */
  const derive = (snapshot: ZaloRuntimeSnapshot): ObservedState | null => {
    switch (snapshot.listener) {
      case "connected":
        return { state_event: "CONNECTED" };
      case "reconnecting":
        return { state_event: "TRANSIENT_DISCONNECT" };
      case "dead":
        // Generic on purpose: "dead" only means the listener gave up retrying (socket
        // stolen, repeated closes). The saved cookies are often still valid, and a
        // BAD_CREDENTIALS here would push the user into a needless QR relogin.
        // BAD_CREDENTIALS is reserved for explicit auth failures from Zalo responses.
        return { state_event: "DISCONNECTED", reason: "listener gave up — re-login required" };
    }
    // listener "stopped"
    if (snapshot.loggedIn) return { state_event: "DISCONNECTED", reason: "listener stopped" };
    if (loggedOutReason) return { state_event: "LOGGED_OUT", reason: loggedOutReason };
    if (lastKnownOwnId) return { state_event: "LOGGED_OUT", reason: "not logged in" };
    return null; // never logged in this process — nothing to file a state under
  };

  const stateKey = (observed: ObservedState, remoteId: string): string =>
    `${observed.state_event}|${remoteId}|${observed.reason ?? ""}`;

  const publish = (opts: { force?: boolean; isRetry?: boolean } = {}): Promise<void> =>
    enqueue(async () => {
      try {
        const snapshot = deps.getSnapshot();
        rememberLogin(snapshot);
        const observed = derive(snapshot);
        if (!observed) return;
        const remoteId = snapshot.ownId ?? lastKnownOwnId;
        if (!remoteId) return;
        const key = stateKey(observed, remoteId);
        if (!opts.force && key === lastPublishedKey) return;

        const profile = observed.state_event === "CONNECTED" ? await withTimeout(deps.getOwnProfile(remoteId)) : null;
        const avatar = profile?.avatarUrl ? await deps.uploadAvatar(profile.avatarUrl).catch(warnAvatar) : undefined;
        const state: RemoteState = {
          state_event: observed.state_event,
          remote_id: remoteId,
          remote_name: profile?.displayName ?? deps.fallbackName,
          ...(observed.reason ? { reason: observed.reason } : {}),
          ...(profile?.displayName ? { remote_profile: { name: profile.displayName, avatar } } : {}),
        };
        if (!(await report(state))) return; // failed — key stays, next heartbeat retries
        lastPublishedKey = key;
        if (state.state_event === "CONNECTED" && !state.remote_profile && !opts.isRetry) {
          scheduleProfileRetry();
        } else {
          cancelProfileRetry();
        }
      } catch (err) {
        console.warn("[beeper] state publish failed:", (err as Error).message);
      }
    });

  const cancelProfileRetry = (): void => {
    if (profileRetryTimer) clearTimeout(profileRetryTimer);
    profileRetryTimer = null;
  };

  /** CONNECTED without remote_profile downgrades name/avatar in Beeper — retry once. */
  const scheduleProfileRetry = (): void => {
    if (profileRetryTimer) return; // never stack retries
    profileRetryTimer = setTimeout(() => {
      profileRetryTimer = null;
      void enqueue(async () => {
        const snapshot = deps.getSnapshot();
        if (snapshot.listener !== "connected" || !snapshot.ownId) return;
        const profile = await withTimeout(deps.getOwnProfile(snapshot.ownId));
        if (!profile?.displayName) return; // still unavailable — one-shot, give up
        const avatar = profile.avatarUrl ? await deps.uploadAvatar(profile.avatarUrl).catch(warnAvatar) : undefined;
        const state: RemoteState = {
          state_event: "CONNECTED",
          remote_id: snapshot.ownId,
          remote_name: profile.displayName,
          remote_profile: { name: profile.displayName, avatar },
        };
        if (await report(state)) lastPublishedKey = stateKey({ state_event: "CONNECTED" }, snapshot.ownId);
      });
    }, PROFILE_RETRY_MS).unref();
  };

  const republish = (): Promise<void> => publish({ force: true });

  // Heartbeat: re-derive the observed state every tick. Unchanged states are still
  // reposted (that's what resets Beeper's staleness clock), a changed state is a
  // transition, and a previously failed publish is retried — at most once per tick.
  // Bridge RUNNING is re-asserted too: a proxy restart resets it to UNCONFIGURED even
  // when no traffic ever flows to trigger the reconnect hook.
  setInterval(() => {
    void republish();
    void reportBridgeState("RUNNING");
  }, HEARTBEAT_MS).unref();

  return {
    publishIfChanged: () => publish(),
    republish,
    loggedOut: (reason: string) => {
      loggedOutReason = reason;
      return publish({ force: true });
    },
    onProxyReconnected: async () => {
      // bbctl proxy resets the bridge-level state to UNCONFIGURED when it restarts and
      // nothing restores it — re-assert RUNNING, then republish the true remote state.
      await reportBridgeState("RUNNING");
      await republish();
    },
  };
}

function warnAvatar(err: Error): undefined {
  console.warn("[beeper] own avatar upload failed:", err.message);
  return undefined;
}

async function withTimeout<T>(promise: Promise<T | null>): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null), // a late rejection must not become an unhandled rejection
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PROFILE_LOOKUP_TIMEOUT_MS).unref()),
  ]);
}

export { AVATAR_MAX_BYTES, PROFILE_LOOKUP_TIMEOUT_MS, HEARTBEAT_MS, PROFILE_RETRY_MS };

/**
 * Build a reporter for a Beeper-hosted bridge. Returns a no-op on any other homeserver,
 * so a self-hosted (non-Beeper) deployment keeps working untouched.
 */
export function createRemoteStateReporter(homeserverUrl: string, bridgeId: string, asToken: string): RemoteStateReporter {
  const username = HUNGRYSERV_USERNAME.exec(homeserverUrl)?.[1];
  if (!username) return async () => true;

  const endpoint = `${BEEPER_API_BASE}/bridgebox/${encodeURIComponent(username)}/bridge/${encodeURIComponent(bridgeId)}/bridge_remote_state`;

  return async (state) => {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${asToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...state, timestamp: Math.floor(Date.now() / 1000) }),
      });
      if (!res.ok) {
        console.warn(`[beeper] remote state ${state.state_event} rejected: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[beeper] remote state ${state.state_event} failed:`, (err as Error).message);
      return false;
    }
  };
}

/** Same shape as the remote-state endpoint but for bridge-level states (`stateEvent`). */
export function createBridgeStateReporter(homeserverUrl: string, bridgeId: string, asToken: string): BridgeStateReporter {
  const username = HUNGRYSERV_USERNAME.exec(homeserverUrl)?.[1];
  if (!username) return async () => true;

  const endpoint = `${BEEPER_API_BASE}/bridgebox/${encodeURIComponent(username)}/bridge/${encodeURIComponent(bridgeId)}/bridge_state`;

  return async (stateEvent) => {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${asToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ stateEvent, timestamp: Math.floor(Date.now() / 1000) }),
      });
      if (!res.ok) {
        console.warn(`[beeper] bridge state ${stateEvent} rejected: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[beeper] bridge state ${stateEvent} failed:`, (err as Error).message);
      return false;
    }
  };
}
