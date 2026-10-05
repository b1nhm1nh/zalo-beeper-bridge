// State machine behavior: derive from the CURRENT snapshot, publish transitions with
// dedupe, heartbeat republish, retry after failed publishes, LOGGED_OUT on logout,
// reconnect republish, and the one-shot profile retry for profile-less CONNECTED.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_MS,
  PROFILE_LOOKUP_TIMEOUT_MS,
  PROFILE_RETRY_MS,
  createZaloStateMachine,
  type RemoteState,
  type ZaloRuntimeSnapshot,
} from "../beeper-bridge-state.ts";

const UID = "12345";

function mockDeps() {
  let snapshot: ZaloRuntimeSnapshot = { loggedIn: false, ownId: null, listener: "stopped" };
  const report = vi.fn(async (_state: RemoteState) => true);
  const reportBridgeState = vi.fn(async (_stateEvent: "STARTING" | "RUNNING") => true);
  const getOwnProfile = vi.fn(async (_uid: string) => ({ displayName: "Bình", avatarUrl: "https://zcdn/a.jpg" }));
  const uploadAvatar = vi.fn(async (_url: string) => "mxc://avatar");
  const sm = createZaloStateMachine({
    homeserverUrl: "https://matrix.beeper.com/_hungryserv/testuser",
    bridgeId: "sh-zalo",
    asToken: "tok",
    fallbackName: "Zalo",
    getSnapshot: () => snapshot,
    getOwnProfile,
    uploadAvatar,
    reporter: report,
    bridgeStateReporter: reportBridgeState,
  });
  return {
    sm,
    report,
    reportBridgeState,
    getOwnProfile,
    uploadAvatar,
    setSnapshot(next: Partial<ZaloRuntimeSnapshot>) {
      snapshot = { ...snapshot, ...next };
    },
    get snapshot() {
      return snapshot;
    },
  };
}

async function flushTimers(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ZaloStateMachine", () => {
  it("publishes CONNECTED with profile + avatar when logged in and the listener is alive", async () => {
    const deps = mockDeps();
    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    const publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    expect(deps.report).toHaveBeenCalledTimes(1);
    expect(deps.report.mock.calls[0]?.[0]).toMatchObject({
      state_event: "CONNECTED",
      remote_id: UID,
      remote_name: "Bình",
      remote_profile: { name: "Bình", avatar: "mxc://avatar" },
    });
    expect(deps.uploadAvatar).toHaveBeenCalledWith("https://zcdn/a.jpg");
  });

  it("dedupes unchanged states: repeated publishIfChanged calls publish nothing new", async () => {
    const deps = mockDeps();
    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    let publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    expect(deps.report).toHaveBeenCalledTimes(1);
  });

  it("maps listener states to the right remote states — dead is generic DISCONNECTED, never BAD_CREDENTIALS", async () => {
    const deps = mockDeps();
    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    let publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;

    deps.setSnapshot({ loggedIn: true, listener: "reconnecting" });
    publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    expect(deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ state_event: "TRANSIENT_DISCONNECT" }));

    // Mirrors ZaloClient after "dead": listener stays "dead", api dropped → ownId null
    deps.setSnapshot({ loggedIn: false, ownId: null, listener: "dead" });
    publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    const last = deps.report.mock.lastCall?.[0];
    expect(last?.state_event).toBe("DISCONNECTED");
    expect(last?.reason).toBeTruthy();
    expect(last?.remote_id).toBe(UID); // filed under the last known account
    expect(deps.report.mock.calls.map((c) => c[0].state_event)).not.toContain("BAD_CREDENTIALS");
  });

  it("skips logged-out state with no state when the process never logged in", async () => {
    const deps = mockDeps();
    const publish = deps.sm.publishIfChanged();
    await flushTimers(10);
    await publish;
    expect(deps.report).not.toHaveBeenCalled();
  });

  it("publishes LOGGED_OUT with the reason on explicit logout, using the last known uid", async () => {
    const deps = mockDeps();
    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    let publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;

    // logout command: api dropped, listener stopped
    deps.setSnapshot({ loggedIn: false, ownId: null, listener: "stopped" });
    publish = deps.sm.loggedOut("logout command");
    await flushTimers(10);
    await publish;
    expect(deps.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ state_event: "LOGGED_OUT", remote_id: UID, reason: "logout command" }),
    );

    // and the heartbeats that follow keep observing LOGGED_OUT, not a stale CONNECTED
    publish = deps.sm.republish();
    await flushTimers(10);
    await publish;
    expect(deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ state_event: "LOGGED_OUT" }));
  });

  it("clears the logged-out state after logging back in", async () => {
    const deps = mockDeps();
    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    let publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;

    deps.setSnapshot({ loggedIn: false, ownId: null, listener: "stopped" });
    publish = deps.sm.loggedOut("logout command");
    await flushTimers(10);
    await publish;

    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    expect(deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ state_event: "CONNECTED" }));
  });

  it("heartbeat republishes the CURRENT observed state and re-asserts bridge RUNNING", async () => {
    const deps = mockDeps();
    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    const publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    expect(deps.report).toHaveBeenCalledTimes(1);

    // logout between ticks — the heartbeat must follow, not repost the stale CONNECTED
    deps.setSnapshot({ loggedIn: false, ownId: null, listener: "stopped" });
    const logout = deps.sm.loggedOut("logout command");
    await flushTimers(10);
    await logout;

    await flushTimers(HEARTBEAT_MS);
    expect(deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ state_event: "LOGGED_OUT" }));
    expect(deps.reportBridgeState).toHaveBeenCalledWith("RUNNING");
  });

  it("retries a FAILED publish on the next heartbeat tick", async () => {
    const deps = mockDeps();
    deps.report.mockResolvedValueOnce(false); // first attempt fails
    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    const publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    expect(deps.report).toHaveBeenCalledTimes(1);

    await flushTimers(HEARTBEAT_MS); // heartbeat retries
    expect(deps.report).toHaveBeenCalledTimes(2);
    expect(deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ state_event: "CONNECTED" }));
  });

  it("republishes the true state when the proxy reconnects", async () => {
    const deps = mockDeps();
    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    const publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    expect(deps.report).toHaveBeenCalledTimes(1);

    // unchanged state, but a proxy restart wiped Beeper's side → force republish
    const reconnect = deps.sm.onProxyReconnected();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await reconnect;
    expect(deps.reportBridgeState).toHaveBeenCalledWith("RUNNING");
    expect(deps.report).toHaveBeenCalledTimes(2);
    expect(deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ state_event: "CONNECTED" }));
  });

  it("schedules a ONE-SHOT retry with the profile after CONNECTED went out without one", async () => {
    const deps = mockDeps();
    // profile lookup hangs past the timeout on first publish
    deps.getOwnProfile.mockImplementation(() => new Promise(() => undefined));
    deps.setSnapshot({ loggedIn: true, ownId: UID, listener: "connected" });
    const publish = deps.sm.publishIfChanged();
    await flushTimers(PROFILE_LOOKUP_TIMEOUT_MS + 1);
    await publish;
    expect(deps.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ state_event: "CONNECTED", remote_name: "Zalo" }),
    );
    const last = deps.report.mock.lastCall?.[0];
    expect(last?.remote_profile).toBeUndefined();

    // profile becomes available; the retry fires once after PROFILE_RETRY_MS
    deps.getOwnProfile.mockImplementation(async () => ({ displayName: "Bình", avatarUrl: "https://zcdn/a.jpg" }));
    await flushTimers(PROFILE_RETRY_MS);
    expect(deps.report).toHaveBeenCalledTimes(2);
    expect(deps.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ state_event: "CONNECTED", remote_profile: { name: "Bình", avatar: "mxc://avatar" } }),
    );

    // one-shot: no further retries
    await flushTimers(PROFILE_RETRY_MS * 2);
    expect(deps.report).toHaveBeenCalledTimes(2);
  });
});
