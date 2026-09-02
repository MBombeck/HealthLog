/**
 * Behavioural suite for the fail-closed Bearer-scope default, against a real
 * Postgres and the real resolver — no mocked Prisma, no mocked `requireAuth`.
 *
 * The gap this pins: `requireAuth()` enforced a token's scope only when the
 * route passed one, and 324 of 330 route files pass none. A token minted for
 * medication intake therefore reached the full-backup export, the labs surface,
 * the coach, and the bulk deletes. B1 is the direct regression test — it fails
 * on the pre-fix tree.
 *
 * Seven cases against 300-odd routes prove nothing about the other routes by
 * enumeration. The guarantee for those is structural (one resolution path, one
 * authorisation arm) and is held by
 * `src/__tests__/bearer-scope-enforcement-guard.test.ts`. What these cases do
 * is prove the arm itself behaves, end to end, for every credential shape the
 * app actually mints.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-bearer-scope-enforcement-32-bytes-min-0987654321";

const { hashToken } = await import("@/lib/auth/hmac");
// The canonical name rather than a literal, so a rename cannot leave these
// cases setting a header nothing reads — which is the exact failure the
// delegation cases below already shipped once.
const { ACCOUNT_SELECTOR_HEADER } = await import("@/lib/auth/acting-carrier");

const USER_ID = "user-bearer-scope-test";
const MCP_RESOURCE = "https://health.example/mcp";
process.env.APP_URL = "https://health.example";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "bearer-scope",
      email: "bearer-scope@example.test",
      timezone: "UTC",
      modulePreferencesJson: { mcp: true },
    },
  });
});

/** Mint a real `ApiToken` row with the given scopes and arm the Bearer header. */
async function armToken(permissions: string[], label = "t"): Promise<string> {
  const raw = `hlk_${label}_${"0".repeat(48)}`;
  await getPrismaClient().apiToken.create({
    data: {
      userId: USER_ID,
      name: label,
      tokenHash: hashToken(raw),
      permissions,
    },
  });
  headerJar.set("authorization", `Bearer ${raw}`);
  return raw;
}

async function armExpiringToken(
  permissions: string[],
  label: string,
  state: { expiresAt?: Date; revoked?: boolean } = {},
): Promise<string> {
  const raw = await armToken(permissions, label);
  await getPrismaClient().apiToken.update({
    where: { tokenHash: hashToken(raw) },
    data: state,
  });
  return raw;
}

function mcpReq(
  rawToken: string,
  method: "initialize" | "tools/list" | "tools/call",
  params?: Record<string, unknown>,
): Request {
  return new Request(MCP_RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${rawToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
}

/** Arm a real cookie session instead of a Bearer token. */
async function useCookieSession(): Promise<void> {
  const session = await getPrismaClient().session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

function req(path: string, method = "GET"): NextRequest {
  const init: RequestInit = { method };
  const raw = headerJar.get("authorization");
  if (raw) init.headers = { authorization: raw };
  return new NextRequest(`https://health.example${path}`, init as never);
}

/** The most recent `auth.bearer.failure` audit row's machine reason. */
async function lastBearerFailureReason(): Promise<string | undefined> {
  const row = await getPrismaClient().auditLog.findFirst({
    where: { action: "auth.bearer.failure" },
    orderBy: { createdAt: "desc" },
  });
  if (!row?.details) return undefined;
  return (JSON.parse(row.details) as { reason?: string }).reason;
}

describe("B1 — a narrow token cannot read the full-account export", () => {
  it("refuses ['medication:ingest'] on GET /api/export/full-backup with 403", async () => {
    // The vulnerability in one request: this is the token the settings card
    // told users to hand to third-party automations, reading every row the
    // account holds.
    await armToken(["medication:ingest"], "narrow");
    const { GET } = await import("@/app/api/export/full-backup/route");

    const res = await GET(req("/api/export/full-backup"));

    expect(res.status).toBe(403);
    const json = (await res.json()) as { data: null; error: string };
    expect(json.data).toBeNull();
    expect(json.error).toBe("Insufficient permissions");

    // The break is visible AND attributable: an operator can name the token.
    // The audit write is fire-and-forget — poll for the value instead of
    // sleeping a fixed span and hoping the runner was fast enough; on
    // timeout the poll asserts against what WAS written.
    await expect
      .poll(() => lastBearerFailureReason(), { timeout: 5_000, interval: 100 })
      .toBe("undeclared_scope");
  });

  it("refuses the same token on GET /api/labs with 403", async () => {
    await armToken(["medication:ingest"], "narrow2");
    const { GET } = await import("@/app/api/labs/route");
    const res = await GET(req("/api/labs"));
    expect(res.status).toBe(403);
  });
});

describe("B2/B3 — the medication-ingest surface is unchanged", () => {
  async function seedMedication(): Promise<string> {
    const med = await getPrismaClient().medication.create({
      data: { userId: USER_ID, name: "Test Med", dose: "1 mg" },
    });
    return med.id;
  }

  it("B2 — the per-medication token still ingests", async () => {
    // The credential that actually performs medication intake. It never
    // touches `requireAuth` — `/api/ingest/medication` hand-rolls the whole
    // resolution — so the fail-closed default cannot reach it. This is the
    // one flow a fail-closed default could plausibly have broken.
    const medId = await seedMedication();
    await armToken(["medication:ingest", `medication:${medId}:ingest`], "pair");
    const { POST } = await import("@/app/api/ingest/medication/route");

    const request = new NextRequest(
      "https://health.example/api/ingest/medication",
      {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          medicationName: "Test Med",
          idempotencyKey: "bearer-scope-b2",
        }),
      } as never,
    );
    const res = await POST(request);

    expect([200, 201]).toContain(res.status);
    const events = await getPrismaClient().medicationIntakeEvent.count({
      where: { userId: USER_ID },
    });
    expect(events).toBe(1);
  });

  it("B3 — a token without the per-medication grant is still refused", async () => {
    // The pre-existing second gate. This is why the retired `/api/tokens`
    // mint never worked for its advertised purpose.
    await seedMedication();
    await armToken(["medication:ingest"], "familyonly");
    const { POST } = await import("@/app/api/ingest/medication/route");

    const request = new NextRequest(
      "https://health.example/api/ingest/medication",
      {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          medicationName: "Test Med",
          idempotencyKey: "bearer-scope-b3",
        }),
      } as never,
    );
    const res = await POST(request);

    expect(res.status).toBe(403);
  });
});

describe("B4 — the native client is not broken", () => {
  it("admits a ['*'] token on GET /api/export/full-backup", async () => {
    // Login, passkey login-verify and refresh rotation all mint `["*"]`, so
    // this is exactly the credential the iOS app holds. If this case ever
    // goes red, the native client is down.
    await armToken(["*"], "wildcard");
    const { GET } = await import("@/app/api/export/full-backup/route");
    const res = await GET(req("/api/export/full-backup"));
    expect(res.status).toBe(200);
  });

  it("admits a ['*'] token on a batch ingest route", async () => {
    await armToken(["*"], "wildcardbatch");
    const { POST } = await import("@/app/api/measurements/batch/route");
    const request = new NextRequest(
      "https://health.example/api/measurements/batch",
      {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 70,
              unit: "kg",
              startDate: new Date().toISOString(),
              endDate: new Date().toISOString(),
              externalId: "uuid-bearer-scope-1",
            },
          ],
        }),
      } as never,
    );
    const res = await POST(request);
    expect(res.status).toBe(200);
  });
});

describe("B5 — an MCP token is audience-bound to /mcp", () => {
  it("refuses ['health:read'] on a REST read", async () => {
    // Narrowing, not breakage: the token's REST read leg was never a feature
    // an MCP client used. Its audience is now /mcp alone.
    await armToken(["health:read"], "mcpread");
    const { GET } = await import("@/app/api/export/full-backup/route");
    const res = await GET(req("/api/export/full-backup"));
    expect(res.status).toBe(403);
  });

  it("still resolves the same token on the /mcp wire", async () => {
    const raw = await armToken(["health:read"], "mcpread2");
    const { resolveMcpAuthContext } = await import("@/lib/mcp/auth");

    const ctx = await resolveMcpAuthContext(raw);

    expect(ctx.userId).toBe(USER_ID);
    expect(ctx.canRead).toBe(true);
    // Read-only token: the write tools stay shut.
    expect(ctx.canWrite).toBe(false);
  });

  it("grants write on /mcp only for a consented health:write token", async () => {
    const raw = await armToken(["health:read", "health:write"], "mcprw");
    const { resolveMcpAuthContext } = await import("@/lib/mcp/auth");
    const ctx = await resolveMcpAuthContext(raw);
    expect(ctx.canWrite).toBe(true);
  });
});

describe("B5b — MCP health reads require an explicit read grant", () => {
  async function postMcp(
    rawToken: string,
    method: "initialize" | "tools/list" | "tools/call",
    params?: Record<string, unknown>,
  ): Promise<Response> {
    const { POST } = await import("@/app/mcp/route");
    return POST(mcpReq(rawToken, method, params));
  }

  it.each([
    ["health:read", ["health:read"]],
    ["wildcard", ["*"]],
  ])("admits %s through capability registration", async (_label, scopes) => {
    const raw = await armToken(scopes, `mcp-positive-${_label}`);

    const res = await postMcp(raw, "tools/list");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toContain("get_labs");
  });

  it.each([
    ["medication ingest", ["medication:ingest"]],
    ["notifications", ["notifications:send"]],
    ["FHIR", ["fhir:read"]],
    ["write-only", ["health:write"]],
    ["unrelated", ["profile:read"]],
  ])(
    "denies a same-user %s token before a real lab read",
    async (_label, scopes) => {
      const raw = await armToken(scopes, `mcp-negative-${_label}`);
      await getPrismaClient().labResult.create({
        data: {
          userId: USER_ID,
          analyte: "LDL",
          value: 177,
          unit: "mg/dL",
          takenAt: new Date("2026-07-20T08:00:00.000Z"),
        },
      });

      const res = await postMcp(raw, "tools/call", {
        name: "get_labs",
        arguments: {},
      });

      expect([401, 403]).toContain(res.status);
      expect(await res.text()).not.toContain("177");
    },
  );

  it.each([
    ["expired", { expiresAt: new Date("2020-01-01T00:00:00.000Z") }],
    ["revoked", { revoked: true }],
  ])(
    "denies an explicit but %s health:read credential",
    async (_label, state) => {
      const raw = await armExpiringToken(
        ["health:read"],
        `mcp-${_label}`,
        state,
      );

      const res = await postMcp(raw, "tools/list");

      expect([401, 403]).toContain(res.status);
    },
  );
});

describe("B6 — a declared scope grants only what it names", () => {
  it("admits ['fhir:read'] on the FHIR face", async () => {
    await armToken(["fhir:read"], "fhir");
    const { GET } = await import("@/app/api/fhir/Observation/route");
    const res = await GET(req("/api/fhir/Observation"));
    expect(res.status).toBe(200);
  });

  it("refuses the same token on /api/labs, which declares no scope", async () => {
    // The whole point of the inversion: holding a scope buys the routes that
    // name it, and nothing else.
    await armToken(["fhir:read"], "fhir2");
    const { GET } = await import("@/app/api/labs/route");
    const res = await GET(req("/api/labs"));
    expect(res.status).toBe(403);
  });
});

describe("B7 — cookie sessions are untouched", () => {
  it("reaches every route the narrow token was refused on", async () => {
    await useCookieSession();

    const backup = await import("@/app/api/export/full-backup/route");
    expect((await backup.GET(req("/api/export/full-backup"))).status).toBe(200);

    const labs = await import("@/app/api/labs/route");
    expect((await labs.GET(req("/api/labs"))).status).toBe(200);

    const fhir = await import("@/app/api/fhir/Observation/route");
    expect((await fhir.GET(req("/api/fhir/Observation"))).status).toBe(200);
  });

  it("requireAdmin still refuses a ['*'] Bearer token", async () => {
    // The cookie-only property of `requireAdmin()` is orthogonal to this
    // change and must stay orthogonal. A wildcard token is the strongest
    // Bearer credential the app mints and it still cannot elevate.
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { role: "ADMIN" },
    });
    await armToken(["*"], "adminwild");

    const { requireAdmin, HttpError } = await import("@/lib/api-handler");
    await expect(requireAdmin()).rejects.toBeInstanceOf(HttpError);
  });
});

describe("B8 — the measurement-ingest scope reaches its two routes and no others", () => {
  /**
   * A second account, plus a live, accepted, record-wide grant letting the
   * token's owner write to it.
   *
   * The grant is the whole point of the delegation cases below. Asserting a
   * 403 against a record nobody shared proves nothing — every credential is
   * refused that. What has to hold is that the scoped token is refused a
   * record its own holder genuinely may write to, which is the case a reader
   * would otherwise assume works.
   */
  async function seedSharedOwner(): Promise<string> {
    const ownerId = "user-bearer-scope-owner";
    await getPrismaClient().user.create({
      data: {
        id: ownerId,
        username: "scope-owner",
        email: "scope-owner@example.test",
        timezone: "UTC",
      },
    });
    await getPrismaClient().accountGrant.create({
      data: {
        grantorId: ownerId,
        granteeId: USER_ID,
        access: "WRITE",
        acceptedAt: new Date(),
      },
    });
    return ownerId;
  }

  function measurementBody(): string {
    return JSON.stringify({
      type: "WEIGHT",
      value: 74.2,
      measuredAt: new Date().toISOString(),
    });
  }

  /**
   * Claim a record for the next request.
   *
   * It goes in the `headerJar`, NOT on the `NextRequest`, and the difference
   * is the whole reason the first version of these cases passed for the wrong
   * reason. `readSelectorHeader()` resolves through `next/headers`, which this
   * suite mocks against the jar — a header set on the request object is never
   * read by the resolver, so the carrier came back `none` and the delegation
   * cases were silently exercising the ordinary own-record path.
   */
  function claimRecord(accountId: string): void {
    headerJar.set(ACCOUNT_SELECTOR_HEADER, accountId);
  }

  function postMeasurement(): NextRequest {
    return new NextRequest("https://health.example/api/measurements", {
      method: "POST",
      headers: {
        authorization: headerJar.get("authorization")!,
        "content-type": "application/json",
      },
      body: measurementBody(),
    } as never);
  }

  it("admits the scope on POST /api/measurements, attributed EXTERNAL", async () => {
    await armToken(["measurements:write"], "mwrite1");
    const { POST } = await import("@/app/api/measurements/route");
    const res = await POST(postMeasurement());

    expect(res.status).toBe(201);
    const row = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: USER_ID, type: "WEIGHT" },
    });
    // v1.38.x — the body names no source (see `measurementBody`), and the
    // route resolves one from the credential rather than falling back on the
    // schema default. This assertion is the whole feature: a reading pushed
    // by a bridge is distinguishable afterwards from one typed by hand.
    expect(row.source).toBe("EXTERNAL");
  });

  it("refuses a body naming MANUAL, rather than overriding it", async () => {
    // The source is server-resolved now, so an explicit assertion has only
    // two possible fates: honoured (and the row is indistinguishable from a
    // typed one, defeating the point) or overridden in silence (which hands
    // the caller a row it did not ask for and no way to notice). The route
    // takes neither and refuses. MANUAL specifically, because it used to be
    // the permitted value — the widening from "names APPLE_HEALTH" to "names
    // anything" is exactly this case.
    await armToken(["measurements:write"], "mwrite1b");
    const { POST } = await import("@/app/api/measurements/route");
    const res = await POST(
      new NextRequest("https://health.example/api/measurements", {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "WEIGHT",
          value: 74.2,
          measuredAt: new Date().toISOString(),
          source: "MANUAL",
        }),
      } as never),
    );

    expect(res.status).toBe(422);
    expect(await getPrismaClient().measurement.count()).toBe(0);
  });

  it("admits the scope on the batch route, attributed MANUAL", async () => {
    await armToken(["measurements:write"], "mwrite2");
    const { POST } = await import("@/app/api/measurements/batch/route");
    const res = await POST(
      new NextRequest("https://health.example/api/measurements/batch", {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 70,
              unit: "kg",
              startDate: new Date().toISOString(),
              endDate: new Date().toISOString(),
              externalId: "uuid-measurements-write-1",
            },
          ],
        }),
      } as never),
    );

    expect(res.status).toBe(200);
    const row = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: USER_ID, externalId: "uuid-measurements-write-1" },
    });
    // Absent `source` defaults to APPLE_HEALTH for the phone and resolves to
    // EXTERNAL here. That also moves the dedup key to
    // `(userId, type, EXTERNAL, externalId)`, so a bridge's externalIds can
    // never collide with the phone's.
    expect(row.source).toBe("EXTERNAL");
  });

  it("does not move the native sync checkpoint", async () => {
    await armToken(["measurements:write"], "mwrite3");
    const { POST } = await import("@/app/api/measurements/batch/route");
    await POST(
      new NextRequest("https://health.example/api/measurements/batch", {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 71,
              unit: "kg",
              startDate: new Date().toISOString(),
              endDate: new Date().toISOString(),
              externalId: "uuid-measurements-write-2",
            },
          ],
        }),
      } as never),
    );

    const user = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: USER_ID },
    });
    expect(user.lastSyncedAt).toBeNull();
    expect(user.healthKitLastSyncedAt).toBeNull();
  });

  it("refuses an entry forging the HealthKit source", async () => {
    await armToken(["measurements:write"], "mwrite4");
    const { POST } = await import("@/app/api/measurements/batch/route");
    const res = await POST(
      new NextRequest("https://health.example/api/measurements/batch", {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 72,
              unit: "kg",
              startDate: new Date().toISOString(),
              endDate: new Date().toISOString(),
              externalId: "uuid-measurements-write-3",
              source: "APPLE_HEALTH",
            },
          ],
        }),
      } as never),
    );

    expect(res.status).toBe(422);
    expect(await getPrismaClient().measurement.count()).toBe(0);
  });

  it("refuses a batch entry naming MANUAL too, not only APPLE_HEALTH", async () => {
    // MANUAL was permitted here while it was also the value the route forced,
    // so nothing was ever overridden. Now it would be, and the sibling case
    // above says why that is refused instead.
    await armToken(["measurements:write"], "mwrite4b");
    const { POST } = await import("@/app/api/measurements/batch/route");
    const res = await POST(
      new NextRequest("https://health.example/api/measurements/batch", {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 73,
              unit: "kg",
              startDate: new Date().toISOString(),
              endDate: new Date().toISOString(),
              externalId: "uuid-measurements-write-3b",
              source: "MANUAL",
            },
          ],
        }),
      } as never),
    );

    expect(res.status).toBe(422);
    expect(await getPrismaClient().measurement.count()).toBe(0);
  });

  it("leaves the row it wrote editable by its owner", async () => {
    // The counterpart to the source split. `EXTERNAL` is outside
    // `WRITABLE_MEASUREMENT_SOURCES` — no client may name it — but it is
    // inside `USER_CORRECTABLE_MEASUREMENT_SOURCES`, because the hardware
    // behind an ingest token is the user's own scale, not a provider. A later
    // tidy-up that folds the two constants back together turns every bridge
    // row value-locked with a 409, and this case is what notices.
    await armToken(["measurements:write"], "mwrite1c");
    const { POST } = await import("@/app/api/measurements/route");
    expect((await POST(postMeasurement())).status).toBe(201);
    const row = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: USER_ID, type: "WEIGHT" },
    });
    expect(row.source).toBe("EXTERNAL");

    // Edit as the owner: a cookie session, no Bearer. The scoped credential
    // could not reach `PUT` at all — that is the point of a write-only scope.
    headerJar.delete("authorization");
    const session = await getPrismaClient().session.create({
      data: {
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    cookieJar.set("healthlog_session", session.id);

    const { PUT } = await import("@/app/api/measurements/[id]/route");
    const res = await PUT(
      new NextRequest(`https://health.example/api/measurements/${row.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 75.1 }),
      } as never),
      { params: Promise.resolve({ id: row.id }) },
    );

    expect(res.status).toBe(200);
    const reread = await getPrismaClient().measurement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(reread.value).toBe(75.1);
    expect(reread.source).toBe("EXTERNAL");
  });

  it("is refused on the read leg of the very same path", async () => {
    // What makes the scope write-only rather than write-named.
    await armToken(["measurements:write"], "mwrite5");
    const { GET } = await import("@/app/api/measurements/route");
    const res = await GET(req("/api/measurements"));

    expect(res.status).toBe(403);
    // Polled, not read once: the audit write is fire-and-forget, so a bare
    // read races the request and reports `undefined` for a row that is about
    // to exist. Same posture as B1 above — on timeout the poll asserts against
    // whatever WAS written rather than passing by default.
    await expect
      .poll(() => lastBearerFailureReason(), { timeout: 5_000, interval: 100 })
      .toBe("undeclared_scope");
  });

  it("is refused on the manage legs and on an unrelated surface", async () => {
    await armToken(["measurements:write"], "mwrite6");

    const bulk = await import("@/app/api/measurements/bulk-delete/route");
    expect(
      (await bulk.POST(req("/api/measurements/bulk-delete", "POST"))).status,
    ).toBe(403);

    const restore = await import("@/app/api/measurements/restore/route");
    expect(
      (await restore.POST(req("/api/measurements/restore", "POST"))).status,
    ).toBe(403);

    const backup = await import("@/app/api/export/full-backup/route");
    expect((await backup.GET(req("/api/export/full-backup"))).status).toBe(403);

    const labs = await import("@/app/api/labs/route");
    expect((await labs.GET(req("/api/labs"))).status).toBe(403);
  });

  it("cannot mint another token", async () => {
    // 401, not 403, and the difference is the point: the mint is cookie-only,
    // so a Bearer is turned away as unauthenticated before any scope is read.
    // The refusal is therefore not "this token's scope is too narrow" — no
    // token is wide enough, a wildcard included.
    await armToken(["measurements:write"], "mwrite7");
    const { POST } = await import("@/app/api/tokens/measurements/route");
    const res = await POST(
      new NextRequest("https://health.example/api/tokens/measurements", {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "second" }),
      } as never),
    );
    expect(res.status).toBe(401);
  });

  it("and neither can a wildcard token", async () => {
    // The case the cookie-only resolver exists for. A native access token
    // lives a day; what this endpoint mints lives a year, so admitting one
    // would let a short-lived compromise leave behind a credential that
    // survives revoking it.
    await armToken(["*"], "wildmint");
    const { POST } = await import("@/app/api/tokens/measurements/route");
    const res = await POST(
      new NextRequest("https://health.example/api/tokens/measurements", {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "minted by a wildcard" }),
      } as never),
    );
    expect(res.status).toBe(401);
    expect(
      await getPrismaClient().apiToken.count({
        where: { permissions: { has: "measurements:write" } },
      }),
    ).toBe(0);
  });

  it("cannot reach the medication ingest surface", async () => {
    await armToken(["measurements:write"], "mwrite8");
    const { POST } = await import("@/app/api/ingest/medication/route");
    const res = await POST(
      new NextRequest("https://health.example/api/ingest/medication", {
        method: "POST",
        headers: {
          authorization: headerJar.get("authorization")!,
          "content-type": "application/json",
        },
        body: JSON.stringify({ medicationName: "x" }),
      } as never),
    );
    expect(res.status).toBe(403);
  });

  it("is refused a shared record its own holder may genuinely write to", async () => {
    const ownerId = await seedSharedOwner();
    await armToken(["measurements:write"], "mwrite9");
    claimRecord(ownerId);

    const { POST } = await import("@/app/api/measurements/route");
    const res = await POST(postMeasurement());

    expect(res.status).toBe(403);
    // Nothing landed on the owner, and nothing quietly landed on the holder
    // instead — the reverse data-mixing failure the resolver exists to avoid.
    expect(await getPrismaClient().measurement.count()).toBe(0);
  });

  it("but a wildcard token writes to that same shared record", async () => {
    // The control for the case above. Without it, a delegation path broken
    // outright would make that 403 look like the scope working.
    const ownerId = await seedSharedOwner();
    await armToken(["*"], "wildshared");
    claimRecord(ownerId);

    const { POST } = await import("@/app/api/measurements/route");
    const res = await POST(postMeasurement());

    expect(res.status).toBe(201);
    const row = await getPrismaClient().measurement.findFirstOrThrow({
      where: { type: "WEIGHT" },
    });
    expect(row.userId).toBe(ownerId);
  });
});
