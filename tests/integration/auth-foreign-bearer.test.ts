/**
 * A Bearer header that is not one of this app's tokens leaves the cookie to
 * decide.
 *
 * A reverse proxy may forward a credential of its own in `Authorization`
 * (oauth2-proxy with `--pass-authorization-header`, a forward-auth answer that
 * sets the header). When every `Bearer …` was read as the token transport,
 * such a header switched the session cookie off on every request: the account
 * read answered 401 and the browser was signed out of the app for good. Only
 * the app's own format (`hlk_…`) is the token transport now.
 *
 * The conflict check stays as it was for the app's own tokens: a valid token
 * of one account beside a live session cookie of another is refused and ends
 * that session. Both secrets arrived on one request, which only the client
 * holding both can send (the session cookie is httpOnly, and no other origin
 * may attach `Authorization` to a request here), so it is that client's
 * sign-out, not a stranger's.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as readMe } from "@/app/api/auth/me/route";

import { anonymous, callRoute } from "../kit/call-route";
import { makeSession, makeToken, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

/** A proxy's JWT: three base64url parts, nothing this app minted. */
const PROXY_JWT =
  "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzb21lb25lIn0.c2lnbmF0dXJlLXBhcnQ";

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe("a foreign Bearer beside the session cookie", () => {
  it("is ignored: the cookie's account is the caller and its session lives", async () => {
    const user = await makeUser();
    const session = await makeSession(user);

    const me = await callRoute<{ id: string }>(readMe, {
      method: "GET",
      route: "/api/auth/me",
      auth: session,
      headers: { authorization: PROXY_JWT },
    });

    expect(me.status).toBe(200);
    expect(me.data.id).toBe(user.id);
    expect(
      await prisma.session.count({ where: { id: session.sessionId } }),
    ).toBe(1);
  });

  it("alone is no credential at all", async () => {
    const me = await callRoute(readMe, {
      method: "GET",
      route: "/api/auth/me",
      auth: anonymous,
      headers: { authorization: PROXY_JWT },
    });
    expect(me.status).toBe(401);
  });
});

describe("one of this app's tokens beside the session cookie", () => {
  it("of the same account: the token is the caller, the session lives", async () => {
    const user = await makeUser();
    const session = await makeSession(user);
    const token = await makeToken(user);

    const me = await callRoute<{ id: string }>(readMe, {
      method: "GET",
      route: "/api/auth/me",
      auth: session,
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(me.status).toBe(200);
    expect(me.data.id).toBe(user.id);
    expect(
      await prisma.session.count({ where: { id: session.sessionId } }),
    ).toBe(1);
  });

  it("of another account: refused, and the session the client presented ends", async () => {
    const cookieOwner = await makeUser();
    const session = await makeSession(cookieOwner);
    const other = await makeUser();
    const token = await makeToken(other);

    const me = await callRoute(readMe, {
      method: "GET",
      route: "/api/auth/me",
      auth: session,
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(me.status).toBe(401);
    expect(
      await prisma.session.count({ where: { id: session.sessionId } }),
    ).toBe(0);
  });

  it("an unknown token of the app's format is refused without touching the session", async () => {
    const user = await makeUser();
    const session = await makeSession(user);

    const me = await callRoute(readMe, {
      method: "GET",
      route: "/api/auth/me",
      auth: session,
      headers: { authorization: `Bearer hlk_${"0".repeat(64)}` },
    });
    expect(me.status).toBe(401);
    expect(
      await prisma.session.count({ where: { id: session.sessionId } }),
    ).toBe(1);
  });
});
