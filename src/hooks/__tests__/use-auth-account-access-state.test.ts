import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetRecordScopeForTests,
  getRecordScope,
  isReadingSharedRecord,
} from "@/lib/query-keys/record-scope";

const apiGet = vi.fn();

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiFetchRaw: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import {
  __resetRecordFenceForTests,
  currentRecordFenceState,
} from "@/lib/api/record-fence";
import {
  adoptMePayload,
  fetchMe,
  NO_ACCOUNT_ACCESS,
  type MePayload,
} from "../use-auth";

const response = {
  id: "delegate",
  username: "delegate",
  role: "USER",
  timezone: "Europe/Berlin",
};

const canonicalEntry = {
  accountId: "record-a",
  username: "record-a",
  displayName: "Record A",
  fullName: null,
  access: "read",
  level: "read",
  recordKind: "shared",
  sections: ["labs"],
  canWrite: false,
  writableDomains: [],
  manageableDomains: [],
};

beforeEach(() => {
  apiGet.mockReset();
  __resetRecordScopeForTests();
  __resetRecordFenceForTests();
});

describe("adoptMePayload on the server render", () => {
  it("resolves the same account without touching browser state", () => {
    // Through JSON, as the layout hands it over.
    const published: MePayload = JSON.parse(
      JSON.stringify({
        ...response,
        accountAccess: {
          accounts: [canonicalEntry],
          active: canonicalEntry,
          recordKind: "shared",
          canSwitch: true,
        },
        recordSession: { epoch: 3, scope: "record-a" },
      }),
    );

    const user = adoptMePayload(published, { apply: false });

    // The value the shell renders from is the browser's.
    expect(user.accountAccessStatus).toBe("valid");
    expect(user.accountAccess?.active).toEqual(canonicalEntry);
    // None of it was applied: the record scope and the fence context are
    // module state, which on the server every request shares.
    expect(getRecordScope()).toBeNull();
    expect(currentRecordFenceState()).toBeNull();

    // Applied, the same payload sets both.
    adoptMePayload(published);
    expect(getRecordScope()).toBe("record-a");
    expect(currentRecordFenceState()).toEqual({ epoch: 3, scope: "record-a" });
  });
});

describe("fetchMe account-access resolution", () => {
  it("keeps a genuinely absent block compatible with an older server", async () => {
    apiGet.mockResolvedValue(response);

    const user = await fetchMe();

    expect(user.accountAccessStatus).toBe("absent");
    expect(user.accountAccess).toEqual(NO_ACCOUNT_ACCESS);
    expect(getRecordScope()).toBeNull();
    expect(isReadingSharedRecord()).toBe(false);
  });

  it("uses a valid published block as the active record scope", async () => {
    apiGet.mockResolvedValue({
      ...response,
      accountAccess: {
        accounts: [canonicalEntry],
        active: canonicalEntry,
        recordKind: "shared",
        canSwitch: true,
      },
    });

    const user = await fetchMe();

    expect(user.accountAccessStatus).toBe("valid");
    expect(user.accountAccess?.active).toEqual(canonicalEntry);
    expect(getRecordScope()).toBe("record-a");
  });

  it.each([
    ["an explicitly undefined block", undefined],
    ["a null block", null],
    [
      "a divergent active entry",
      {
        accounts: [canonicalEntry],
        active: {
          ...canonicalEntry,
          access: "write",
          level: "write",
          canWrite: true,
        },
        recordKind: "shared",
        canSwitch: true,
      },
    ],
  ])(
    "refuses %s without restoring an owner cache scope",
    async (_name, block) => {
      apiGet.mockResolvedValue({ ...response, accountAccess: block });

      const user = await fetchMe();

      expect(user.accountAccessStatus).toBe("invalid");
      expect(user.accountAccess).toEqual(NO_ACCOUNT_ACCESS);
      expect(getRecordScope()).not.toBeNull();
      expect(isReadingSharedRecord()).toBe(true);
    },
  );
});
