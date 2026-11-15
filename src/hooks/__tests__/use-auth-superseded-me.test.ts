import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetRecordFenceForTests,
  currentRecordFenceState,
} from "@/lib/api/record-fence";
import {
  __resetRecordScopeForTests,
  getRecordScope,
  setRecordScope,
} from "@/lib/query-keys/record-scope";
import {
  __resetRecordSessionTransitionForTests,
  beginRecordSessionTransition,
  commitRecordSessionTransition,
  getRecordSessionTransition,
} from "@/lib/query-keys/record-session-transition";

const apiGet = vi.fn();

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiFetchRaw: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { fetchMe } from "../use-auth";

/**
 * A `/api/auth/me` answered across a record-session transition.
 *
 * The browser journey that found this: the switcher clears the query cache
 * when it raises the hold, which remounts the account query, so the initiating
 * tab has a `/me` in flight beside its own switch POST. The server answers it
 * with the record being left. Applied after the commit, that answer rewrote the
 * scope mirror to the old record, a settled peer read the write as a foreign
 * switch, and every tab then waited for a `/me` naming a record the server had
 * already left — behind the hydration gate, for good.
 */

const TARGET = "record-b";

const entry = {
  accountId: TARGET,
  username: "record-b",
  displayName: null,
  fullName: null,
  access: "read",
  level: "read",
  recordKind: "shared",
  sections: null,
  canWrite: false,
  writableDomains: [],
  manageableDomains: [],
};

const base = {
  id: "delegate",
  username: "delegate",
  role: "USER",
  timezone: "Europe/Berlin",
};

/** What the server says before the switch lands: the caller's own record. */
const beforeSwitch = {
  ...base,
  accountAccess: {
    accounts: [entry],
    active: null,
    recordKind: "self",
    canSwitch: true,
  },
  recordSession: { epoch: 4, scope: null },
};

/** And after it. */
const afterSwitch = {
  ...base,
  accountAccess: {
    accounts: [entry],
    active: entry,
    recordKind: "shared",
    canSwitch: true,
  },
  recordSession: { epoch: 5, scope: TARGET },
};

beforeEach(() => {
  apiGet.mockReset();
  __resetRecordScopeForTests();
  __resetRecordSessionTransitionForTests();
  __resetRecordFenceForTests();
});

describe("fetchMe across a record-session transition", () => {
  it("drops an answer that straddled the commit and reads again", async () => {
    setRecordScope(null);
    const id = beginRecordSessionTransition(TARGET);

    apiGet
      .mockImplementationOnce(async () => {
        // The switch commits while this read is on the wire, and the server
        // had already answered it from the record being left.
        commitRecordSessionTransition(id, TARGET);
        return beforeSwitch;
      })
      .mockResolvedValueOnce(afterSwitch);

    const user = await fetchMe();

    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(user.accountAccess?.active?.accountId).toBe(TARGET);
    // The committed scope survives; the pre-switch answer never reached the
    // mirror or the fence.
    expect(getRecordScope()).toBe(TARGET);
    expect(currentRecordFenceState()).toEqual({ epoch: 5, scope: TARGET });
    // And the hold releases on the read that describes the switched session.
    expect(getRecordSessionTransition().phase).toBe("ready");
  });

  it("applies an answer when nothing moved while it was in flight", async () => {
    const id = beginRecordSessionTransition(TARGET);
    commitRecordSessionTransition(id, TARGET);
    apiGet.mockResolvedValueOnce(afterSwitch);

    await fetchMe();

    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(getRecordScope()).toBe(TARGET);
    expect(getRecordSessionTransition().phase).toBe("ready");
  });

  it("gives up without applying anything when the session never holds still", async () => {
    setRecordScope(null);
    apiGet.mockImplementation(async () => {
      // Every read straddles a fresh transition.
      beginRecordSessionTransition(TARGET);
      return beforeSwitch;
    });

    await expect(fetchMe()).rejects.toThrow(/kept moving/);
    expect(apiGet).toHaveBeenCalledTimes(4);
    expect(currentRecordFenceState()).toBeNull();
  });
});
