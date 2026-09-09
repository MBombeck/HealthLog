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

import { fetchMe, NO_ACCOUNT_ACCESS } from "../use-auth";

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
