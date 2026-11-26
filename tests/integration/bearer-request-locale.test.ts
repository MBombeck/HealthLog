/**
 * An app request is worded in the language the app runs in.
 *
 * The app authenticates with a Bearer token, carries no locale cookie and
 * names its language in `Accept-Language`. Only the daily digest let that
 * header outrank the account's stored language; every other route resolved
 * the stored one first, so an app running in German on an account stored as
 * English read English narratives and labels. This suite holds
 * the daily digest, the period narrative and the nutrient catalogue to the
 * header on a Bearer request, and to the account's stored language without
 * one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

import { hashToken } from "@/lib/auth/hmac";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  const { __resetAllCachesForTests } = await import("@/lib/cache/server-cache");
  __resetAllCachesForTests();
});

let counter = 0;

/** An account stored as English, signed in with an app token. */
async function appAccount(locale: string | null = "en") {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `bearer-locale-${counter}`,
      email: `bearer-locale-${counter}@example.test`,
      role: "USER",
      locale,
      modulePreferencesJson: { nutrients: true },
    },
  });
  const raw = `hlk_bearer-locale-${counter++}`.padEnd(24, "0");
  await prisma.apiToken.create({
    data: {
      userId: user.id,
      name: "app",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  headerJar.set("authorization", `Bearer ${raw}`);
  return user;
}

function request(path: string, acceptLanguage: string | null): NextRequest {
  if (acceptLanguage) headerJar.set("accept-language", acceptLanguage);
  return new NextRequest(`http://localhost${path}`, {
    headers: {
      authorization: headerJar.get("authorization") ?? "",
      ...(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
    },
  });
}

async function json(res: Response) {
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe("worded routes on a Bearer request", () => {
  it("words the daily digest in the app's language", async () => {
    await appAccount();
    const { GET } = await import("@/app/api/daily/digest/route");
    const body = await json(await GET(request("/api/daily/digest", "de-DE")));
    expect((body.languages as { response: string }).response).toBe("de");
  });

  it("reads the period narrative in the app's language", async () => {
    await appAccount();
    const { GET } = await import("@/app/api/insights/narrative/route");
    const body = await json(
      await GET(request("/api/insights/narrative?period=week", "de-DE")),
    );
    expect(body.locale).toBe("de");
  });

  it("names the nutrients in the app's language", async () => {
    await appAccount();
    const { GET } = await import("@/app/api/nutrients/catalog/route");
    const de = (await json(
      await (GET as unknown as (r: Request) => Promise<Response>)(
        request("/api/nutrients/catalog", "de-DE"),
      ),
    )) as unknown as { entries?: Array<{ code: string; label: string }> };
    headerJar.delete("accept-language");
    const en = (await json(
      await (GET as unknown as (r: Request) => Promise<Response>)(
        request("/api/nutrients/catalog", "en-US"),
      ),
    )) as unknown as { entries?: Array<{ code: string; label: string }> };
    const label = (body: typeof de, code: string) =>
      body.entries?.find((e) => e.code === code)?.label;
    expect(label(de, "iron")).toBe("Eisen");
    expect(label(de, "zinc")).toBe("Zink");
    expect(label(en, "iron")).toBe("Iron");
  });

  it("keeps the stored language when the request names none", async () => {
    await appAccount("de");
    const { GET } = await import("@/app/api/insights/narrative/route");
    const body = await json(
      await GET(request("/api/insights/narrative?period=week", null)),
    );
    expect(body.locale).toBe("de");
  });
});
