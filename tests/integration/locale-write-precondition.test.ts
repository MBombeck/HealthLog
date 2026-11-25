/**
 * A tab's language write never puts an older or guessed language over a
 * newer choice.
 *
 * Every signed-in tab sends `PUT /api/auth/me/locale` with the language it
 * rendered, once, with `keepalive`. The body is a choice only when it agrees
 * with the browser's locale cookie, which every switch writes before the
 * request goes out. Otherwise it is stale (another tab switched since) or a
 * guess (no cookie: the page rendered the browser's Accept-Language), and the
 * route answers with the language in force instead of storing the body.
 *
 * The reply's cookie is the other half. A reply that set the cookie to the
 * request's language could land after a switch made in another tab and put
 * the older language back for the whole browser, so the route only sets the
 * cookie where it changes it.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { PUT } from "@/app/api/auth/me/locale/route";
import { sessionCookieName } from "@/lib/auth/session-cookie";
import { LOCALE_COOKIE } from "@/lib/i18n/locale-cookie";

import { callRoute } from "../kit/call-route";
import { makeSession, makeToken, makeUser } from "../kit/factories";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  delete process.env.DEMO_MODE;
});

async function storedLocale(userId: string): Promise<string | null> {
  const row = await getPrismaClient().user.findUniqueOrThrow({
    where: { id: userId },
    select: { locale: true },
  });
  return row.locale;
}

/**
 * A browser tab's PUT: the session cookie plus, when the browser has one, the
 * locale cookie it carried at send time. Returns the answered locale and the
 * locale cookie as the browser holds it after the reply, with every cookie
 * the reply set recorded in order.
 */
async function tabPut(options: {
  stored: string | null;
  cookie: string | null;
  body: string;
}) {
  const user = await makeUser({ locale: options.stored });
  const auth = await makeSession(user);
  cookieJar.clear();
  cookieJar.set(sessionCookieName(), auth.cookie);
  if (options.cookie) cookieJar.set(LOCALE_COOKIE, options.cookie);

  const written: string[] = [];
  const originalSet = cookieJar.set.bind(cookieJar);
  cookieJar.set = (name: string, value: string) => {
    if (name === LOCALE_COOKIE) written.push(value);
    return originalSet(name, value);
  };
  let res: Response;
  try {
    res = await PUT(
      new NextRequest("http://localhost:3000/api/auth/me/locale", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: options.body }),
      }),
    );
  } finally {
    cookieJar.set = originalSet;
  }
  // The session read writes the column fire-and-forget; let it land.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const json = (await res.json()) as { data: { locale: string } | null };
  return {
    status: res.status,
    answered: json.data?.locale ?? null,
    written,
    stored: await storedLocale(user.id),
  };
}

describe("PUT /api/auth/me/locale precondition (real Postgres)", () => {
  it("a stale tab does not put its older language back", async () => {
    // Another tab switched to German; this tab still renders English and its
    // write goes out with the cookie the switch left behind.
    const result = await tabPut({ stored: "de", cookie: "de", body: "en" });
    expect(result.status).toBe(200);
    expect(result.stored).toBe("de");
    expect(result.answered).toBe("de");
    expect(result.written).not.toContain("en");
  });

  it("a tab that agrees with its cookie sets no cookie in reply", async () => {
    // The reply would otherwise carry `en` back after a switch made while
    // the keepalive request was still in flight.
    const result = await tabPut({ stored: "en", cookie: "en", body: "en" });
    expect(result.status).toBe(200);
    expect(result.answered).toBe("en");
    expect(result.written).toEqual([]);
  });

  it("an explicit switch reaches the account", async () => {
    const result = await tabPut({ stored: "en", cookie: "fr", body: "fr" });
    expect(result.stored).toBe("fr");
    expect(result.answered).toBe("fr");
  });

  it("a guessed language does not replace the stored choice", async () => {
    // A new device signs in with an English system language and no cookie;
    // the account chose German elsewhere.
    const result = await tabPut({ stored: "de", cookie: null, body: "en" });
    expect(result.stored).toBe("de");
    expect(result.answered).toBe("de");
    expect(result.written).not.toContain("en");
    expect(result.written).toContain("de");
  });

  it("a guessed language still fills an account that never chose", async () => {
    const result = await tabPut({ stored: null, cookie: null, body: "fr" });
    expect(result.stored).toBe("fr");
    expect(result.answered).toBe("fr");
    expect(result.written).toEqual(["fr"]);
  });

  it("a native client's choice is written as sent", async () => {
    const user = await makeUser({ locale: "de" });
    const token = await makeToken(user);
    const res = await callRoute<{ locale: string }>(PUT, {
      method: "PUT",
      route: "/api/auth/me/locale",
      body: { locale: "en" },
      auth: token,
    });
    expect(res.status).toBe(200);
    expect(res.data.locale).toBe("en");
    expect(await storedLocale(user.id)).toBe("en");
  });
});
