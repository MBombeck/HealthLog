/**
 * The `accountAccess` block on `GET /api/auth/me`, over the real route,
 * against real Postgres.
 *
 * The block is the only thing either client is allowed to know about its own
 * sharing permissions, so what is tested here is not "the field is present"
 * but "the field says the same thing the request resolver would". Every case
 * below is a state the grant table can actually be in — pending, active,
 * expired, revoked, self — and the question each time is whether the payload
 * would let a client paint a switcher entry the server would then refuse.
 *
 * Nothing is mocked below the route. A unit test with a stubbed Prisma could
 * prove the route calls the resolver; it could not prove that a grant which
 * lapsed an hour ago drops out of the list, which is the property the whole
 * block exists to carry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: () => {},
      delete: () => {},
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { ACCOUNT_SELECTOR_HEADER } from "@/lib/api-handler";
import { hashToken } from "@/lib/auth/hmac";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `access-${suffix}`,
      email: `access-${suffix}@example.test`,
      displayName: `Access ${suffix}`,
      role: "USER",
      onboardingCompletedAt: new Date(),
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

interface AccountAccessEntry {
  accountId: string;
  username: string;
  displayName: string | null;
  access: "read" | "write" | "manage";
  level: "read" | "write" | "manage";
  sections: string[] | null;
  canWrite: boolean;
}

interface AccountAccessBlock {
  accounts: AccountAccessEntry[];
  active: AccountAccessEntry | null;
  canSwitch: boolean;
}

async function readMe(): Promise<{
  status: number;
  accountAccess: AccountAccessBlock;
  id: string;
}> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await GET();
  const body = (await res.json()) as {
    data: { id: string; accountAccess: AccountAccessBlock };
  };
  return {
    status: res.status,
    accountAccess: body.data?.accountAccess,
    id: body.data?.id,
  };
}

/** An accepted, never-ending grant from `grantorId` to `granteeId`. */
async function grantAccess(
  grantorId: string,
  granteeId: string,
  extra: {
    expiresAt?: Date | null;
    acceptedAt?: Date | null;
    access?: "READ" | "WRITE" | "MANAGE";
    scopeJson?: unknown;
  } = {},
) {
  return getPrismaClient().accountGrant.create({
    data: {
      grantorId,
      granteeId,
      access: extra.access ?? "READ",
      invitedAt: new Date(),
      acceptedAt:
        extra.acceptedAt === undefined ? new Date() : extra.acceptedAt,
      expiresAt: extra.expiresAt ?? null,
      ...(extra.scopeJson === undefined
        ? {}
        : { scopeJson: extra.scopeJson as never }),
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("accountAccess — what the payload publishes", () => {
  it("is present and empty for an account nobody has shared with", async () => {
    const alone = await makeUser("alone");
    await signIn(alone.id);

    const { status, accountAccess } = await readMe();

    expect(status).toBe(200);
    // Present, not missing. A client that got no field could not tell "this
    // server does not do sharing" from "nobody shared anything with me", and
    // would have to guess which.
    expect(accountAccess).toEqual({
      accounts: [],
      active: null,
      canSwitch: false,
    });
  });

  it("lists an accepted grant with the level resolved, and canWrite false", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id);
    await signIn(delegate.id);

    const { accountAccess } = await readMe();

    expect(accountAccess.accounts).toEqual([
      {
        accountId: owner.id,
        username: owner.username,
        displayName: owner.displayName,
        access: "read",
        level: "read",
        sections: null,
        canWrite: false,
      },
    ]);
    expect(accountAccess.canSwitch).toBe(true);
    expect(accountAccess.active).toBeNull();
  });

  it("omits a pending invitation — being offered access is not having it", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id, { acceptedAt: null });
    await signIn(delegate.id);

    const { accountAccess } = await readMe();

    expect(accountAccess.accounts).toEqual([]);
    expect(accountAccess.canSwitch).toBe(false);
  });

  it("omits a grant that has lapsed, against the request clock", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    await signIn(delegate.id);

    const { accountAccess } = await readMe();

    expect(accountAccess.accounts).toEqual([]);
  });

  it("omits a revoked grant", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const grant = await grantAccess(owner.id, delegate.id);
    await getPrismaClient().accountGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });
    await signIn(delegate.id);

    const { accountAccess } = await readMe();

    expect(accountAccess.accounts).toEqual([]);
  });

  it("publishes the sections a scoped grant opens, exactly as stored", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id, {
      // Stored out of the consent screen's order on purpose: what the payload
      // publishes is a resolved value in the reading order, not the column.
      scopeJson: ["labs", "medications"],
    });
    await signIn(delegate.id);

    const { accountAccess } = await readMe();

    expect(accountAccess.accounts[0].sections).toEqual(["medications", "labs"]);
    expect(accountAccess.accounts[0].level).toBe("read");
  });

  it("publishes the whole record as null, never as a list of eight", async () => {
    // Null is the answer every pre-v1.37.0 grant carries and the one an owner
    // who does not narrow still gives. Expanding it into all eight sections
    // would turn a first-class value into a choice nobody made, and would
    // start growing by release — a grant would quietly gain a section the
    // owner never agreed to.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id);
    await signIn(delegate.id);

    const { accountAccess } = await readMe();

    expect(accountAccess.accounts[0].sections).toBeNull();
  });

  it("publishes nothing at all for a scope it cannot read", async () => {
    // Fail-closed, end to end. A blob this build cannot parse resolves to the
    // empty set in the resolver, so the payload says the same: the grant
    // opens nothing. A payload that reported null here would paint a full
    // switcher entry for a grant the server refuses on every request.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id, { scopeJson: "garbage" });
    await signIn(delegate.id);

    const { accountAccess } = await readMe();

    expect(accountAccess.accounts[0].sections).toEqual([]);
  });

  it("publishes a manage grant as manage, and as writable", async () => {
    // The shipped expression was `access === "WRITE" ? "write" : "read"`,
    // which would have published a grant that can delete entries as read-only
    // — the payload understating access is the direction that reads as safe
    // and is not, because the server would have gone on admitting the writes.
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id, { access: "MANAGE" });
    await signIn(delegate.id);

    const { accountAccess } = await readMe();

    expect(accountAccess.accounts[0].level).toBe("manage");
    expect(accountAccess.accounts[0].access).toBe("manage");
    expect(accountAccess.accounts[0].canWrite).toBe(true);
    expect(accountAccess.accounts[0].sections).toBeNull();
  });

  it("never lists a grant this account GAVE — the block is about what it may open", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id);
    // The owner signs in. They gave the access; they did not receive any.
    await signIn(owner.id);

    const { accountAccess } = await readMe();

    expect(accountAccess.accounts).toEqual([]);
    expect(accountAccess.canSwitch).toBe(false);
  });
});

describe("accountAccess — the active record", () => {
  it("resolves the stamped account to a full entry, not just an id", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id);
    const session = await signIn(delegate.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });

    const { accountAccess, id } = await readMe();

    // Still the delegate's own payload — the switch changes which record the
    // delegable routes read, never whose preferences /me returns.
    expect(id).toBe(delegate.id);
    expect(accountAccess.active).toEqual({
      accountId: owner.id,
      username: owner.username,
      displayName: owner.displayName,
      access: "read",
      level: "read",
      sections: null,
      canWrite: false,
    });
    // The active entry is one of the listed ones, by construction. A banner
    // that had to join the two could render unnamed when they disagreed.
    expect(accountAccess.accounts).toContainEqual(accountAccess.active);
  });

  it("reads as not-switched when the stamp outlives the grant", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const grant = await grantAccess(owner.id, delegate.id);
    const session = await signIn(delegate.id);
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });
    // The grant lapses while the browser sits inside the record. Expiry has
    // no session cleanup — only revocation does — so the stamp survives it.
    await getPrismaClient().accountGrant.update({
      where: { id: grant.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const { accountAccess } = await readMe();

    // The payload agrees with what the resolver will decide about the next
    // delegated read: there is no live grant, so there is no active record.
    // The client's job is to clear the stamp, which is what the
    // `sharing.access.denied` reset does.
    expect(accountAccess.active).toBeNull();
    expect(accountAccess.accounts).toEqual([]);
  });
});

describe("accountAccess — the actor surface refuses a selector header", () => {
  it("refuses a Bearer caller that attaches an account selector", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id);

    const raw = `hlk_${delegate.id}-token`.padEnd(20, "0");
    await getPrismaClient().apiToken.create({
      data: {
        userId: delegate.id,
        name: "account-access-test",
        tokenHash: hashToken(raw),
        permissions: ["*"],
      },
    });

    cookieJar.clear();
    headerJar.set("authorization", `Bearer ${raw}`);
    headerJar.set(ACCOUNT_SELECTOR_HEADER, owner.id);

    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET();
    const body = (await res.json()) as { meta?: { errorCode?: string } };

    // The account payload is DEFINED as the caller's own. A client that
    // attached a selector to it believes it is asking about the owner and is
    // not; answering correctly to the wrong question is how a support ticket
    // about "data that looks wrong" starts.
    expect(res.status).toBe(403);
    expect(body.meta?.errorCode).toBe("sharing.not_permitted");
  });

  it("serves a Bearer caller with no selector, and reports no active record", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await grantAccess(owner.id, delegate.id);

    const raw = `hlk_${delegate.id}-plain`.padEnd(20, "0");
    await getPrismaClient().apiToken.create({
      data: {
        userId: delegate.id,
        name: "account-access-test",
        tokenHash: hashToken(raw),
        permissions: ["*"],
      },
    });

    cookieJar.clear();
    headerJar.set("authorization", `Bearer ${raw}`);

    const { status, accountAccess } = await readMe();

    expect(status).toBe(200);
    // The token transport carries its selector per request, so this payload
    // is never inside a record. `accounts` still answers "which records may
    // I open", which is what the native switcher renders.
    expect(accountAccess.active).toBeNull();
    expect(accountAccess.accounts).toHaveLength(1);
    expect(accountAccess.canSwitch).toBe(true);
  });
});
