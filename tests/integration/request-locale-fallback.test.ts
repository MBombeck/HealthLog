/**
 * An account with no stored language is answered in the request's language.
 *
 * `User.locale` stays NULL until someone picks a language. Request-time text
 * that read that column alone fell back to English, so an iPhone running in
 * German saw "Clinical lower limit" on its glucose chart. Every request now
 * resolves its language through `resolveServerLocale`: the stored language
 * when there is one, else `Accept-Language`, else the instance default. This
 * suite holds the series route's reference lines to that on a Bearer request.
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

/** An account that never picked a language, signed in with an app token. */
async function appAccount(locale: string | null) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `request-locale-${counter}`,
      email: `request-locale-${counter}@example.test`,
      role: "USER",
      locale,
    },
  });
  const raw = `hlk_request-locale-${counter++}`.padEnd(24, "0");
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
  else headerJar.delete("accept-language");
  return new NextRequest(`http://localhost${path}`, {
    headers: {
      authorization: headerJar.get("authorization") ?? "",
      ...(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
    },
  });
}

async function seriesLabels(acceptLanguage: string | null): Promise<string[]> {
  const { GET } = await import("@/app/api/measurements/series/route");
  const res = await GET(
    request("/api/measurements/series?kind=glucose&days=30", acceptLanguage),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { referenceLines: Array<{ label: string }> };
  };
  // The sweep is only meaningful if the route answered lines at all.
  expect(body.data.referenceLines.length).toBeGreaterThan(0);
  return body.data.referenceLines.map((line) => line.label);
}

describe("series reference lines on a Bearer request", () => {
  it("are German for Accept-Language: de when the account stores no language", async () => {
    await appAccount(null);
    const labels = await seriesLabels("de");
    expect(labels).toContain("Klinische Untergrenze");
    expect(labels).not.toContain("Clinical lower limit");
  });

  it("are English with no Accept-Language and no stored language", async () => {
    await appAccount(null);
    expect(await seriesLabels(null)).toContain("Clinical lower limit");
  });

  it("follow the stored language when the app names none", async () => {
    await appAccount("de");
    expect(await seriesLabels(null)).toContain("Klinische Untergrenze");
  });
});
