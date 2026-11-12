/**
 * The language a demo visitor picks stays with that visitor.
 *
 * A demo is one published account every visitor signs into. Two paths write
 * the account's language: `PUT /api/auth/me/locale`, and the session read,
 * which copies the language cookie into the row when the two differ. On a
 * demo both leave the shared row alone, so one visitor's choice is not the
 * next visitor's starting language; everywhere else both keep writing it.
 * The verdict is read back from the row: the route answers 200 either way.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PUT } from "@/app/api/auth/me/locale/route";
import { getSession } from "@/lib/auth/session";
import { sessionCookieName } from "@/lib/auth/session-cookie";
import { LOCALE_COOKIE } from "@/lib/i18n/locale-cookie";

import { callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
});

async function storedLocale(userId: string): Promise<string | null> {
  const row = await getPrismaClient().user.findUniqueOrThrow({
    where: { id: userId },
    select: { locale: true },
  });
  return row.locale;
}

async function putLocale(locale: string, demo: boolean) {
  if (demo) process.env.DEMO_MODE = "true";
  else delete process.env.DEMO_MODE;
  const user = await makeUser({ locale: "en" });
  const auth = await makeSession(user);
  const res = await callRoute(PUT, {
    method: "PUT",
    route: "/api/auth/me/locale",
    body: { locale },
    auth,
  });
  return { status: res.status, userId: user.id };
}

/** A session read with the visitor's language cookie set to `locale`. */
async function readSessionWithCookie(locale: string, demo: boolean) {
  if (demo) process.env.DEMO_MODE = "true";
  else delete process.env.DEMO_MODE;
  const user = await makeUser({ locale: "en" });
  const auth = await makeSession(user);
  cookieJar.set(sessionCookieName(), auth.cookie);
  cookieJar.set(LOCALE_COOKIE, locale);
  const signedIn = await getSession();
  // The session read writes fire-and-forget; give it the moment it needs.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { signedIn, userId: user.id };
}

describe("the account language under DEMO_MODE (real Postgres)", () => {
  it("PUT stores the language on an ordinary instance", async () => {
    const { status, userId } = await putLocale("de", false);
    expect(status).toBe(200);
    expect(await storedLocale(userId)).toBe("de");
  });

  it("PUT on a demo answers 200 and leaves the shared row alone", async () => {
    const { status, userId } = await putLocale("de", true);
    expect(status).toBe(200);
    expect(await storedLocale(userId)).toBe("en");
  });

  it("the session read copies the cookie language on an ordinary instance", async () => {
    const { signedIn, userId } = await readSessionWithCookie("fr", false);
    expect(signedIn?.user.locale).toBe("fr");
    expect(await storedLocale(userId)).toBe("fr");
  });

  it("the session read on a demo answers in the cookie language without writing it", async () => {
    const { signedIn, userId } = await readSessionWithCookie("fr", true);
    expect(signedIn?.user.locale).toBe("fr");
    expect(await storedLocale(userId)).toBe("en");
  });
});
