/**
 * The Antigravity routes, through the real handlers and the real database.
 *
 * `callRoute` runs each handler through `apiHandler` with a browser session,
 * and checks the answer against the OpenAPI registry. The CLI is a fake `agy`
 * process on PATH (see `antigravity-fake-agy.ts`), so the connection test,
 * the model list and the model choice exercise the real ACP client.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as disconnectRoute from "@/app/api/antigravity/disconnect/route";
import * as installRoute from "@/app/api/antigravity/install/route";
import * as modelRoute from "@/app/api/antigravity/model/route";
import * as modelsRoute from "@/app/api/antigravity/models/route";
import * as statusRoute from "@/app/api/antigravity/status/route";
import * as testRoute from "@/app/api/antigravity/test/route";

import type { Prisma } from "@/generated/prisma/client";

import { callRoute } from "../kit/call-route";
import { makeAdmin, makeSession, makeUser } from "../kit/factories";

import { installFakeAgy, type FakeAgy } from "./antigravity-fake-agy";
import { getPrismaClient, truncateAllTables } from "./setup";

const READY = "prof-ready";
/** A profile id in the form the app generates: 32 lowercase hex characters. */
const GENERATED = "0123456789abcdef0123456789abcdef";

let fake: FakeAgy;

beforeAll(() => {
  fake = installFakeAgy();
  mkdirSync(path.join(fake.profileRoot, READY));
  mkdirSync(path.join(fake.profileRoot, "logged-out-1"));
  mkdirSync(path.join(fake.profileRoot, "logged-out-2"));
});

afterAll(() => {
  fake.cleanup();
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

/** A signed-in user with the given Antigravity state. */
async function signedIn(
  state: {
    profileId?: string | null;
    model?: string | null;
    connectionStatus?: string;
    connectedAt?: Date | null;
    capabilities?: Prisma.InputJsonValue;
  } = {},
) {
  const user = await makeUser({
    antigravityProfileId: state.profileId ?? null,
    antigravityModel: state.model ?? null,
    antigravityConnectionStatus: state.connectionStatus ?? "disconnected",
    antigravityConnectedAt: state.connectedAt ?? null,
    antigravityCapabilitiesJson: state.capabilities ?? undefined,
  });
  const session = await makeSession(user);
  return { user, session };
}

async function stored(userId: string) {
  return getPrismaClient().user.findUniqueOrThrow({ where: { id: userId } });
}

describe("GET /api/antigravity/status", () => {
  it("tells an administrator the CLI may be installed, and any other user it may not", async () => {
    const admin = await makeSession(await makeAdmin());
    const member = await signedIn();

    const asAdmin = await callRoute(statusRoute.GET, {
      method: "GET",
      route: "/api/antigravity/status",
      auth: admin,
    });
    const asMember = await callRoute(statusRoute.GET, {
      method: "GET",
      route: "/api/antigravity/status",
      auth: member.session,
    });

    expect(asAdmin.data).toMatchObject({ canInstallCli: true });
    expect(asMember.data).toMatchObject({ canInstallCli: false });
  });

  it("reports the installed CLI and a user with no profile yet", async () => {
    const { session } = await signedIn();

    const result = await callRoute(statusRoute.GET, {
      method: "GET",
      route: "/api/antigravity/status",
      auth: session,
    });

    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      cliInstalled: true,
      cliVersion: "1.5.8",
      profileId: null,
      connectionStatus: "disconnected",
      connectedAt: null,
      capabilities: null,
    });
  });

  it("returns the stored result of the last connection test", async () => {
    const connectedAt = new Date("2026-11-01T10:00:00Z");
    const { session } = await signedIn({
      profileId: READY,
      connectionStatus: "connected",
      connectedAt,
      capabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
      },
    });

    const result = await callRoute(statusRoute.GET, {
      method: "GET",
      route: "/api/antigravity/status",
      auth: session,
    });

    expect(result.data).toMatchObject({
      profileId: READY,
      connectionStatus: "connected",
      connectedAt: connectedAt.toISOString(),
      capabilities: { image: true, embeddedContext: true },
    });
  });
});

describe("POST /api/antigravity/install", () => {
  it("refuses a signed-in user who is not an administrator", async () => {
    const { session } = await signedIn();

    const result = await callRoute(installRoute.POST, {
      method: "POST",
      route: "/api/antigravity/install",
      auth: session,
    });

    expect(result.status).toBe(403);
  });

  it("answers an administrator without downloading, when the CLI is already there", async () => {
    // The fake binary is configured, so the installer finds it and makes no request.
    const admin = await makeSession(await makeAdmin());

    const result = await callRoute(installRoute.POST, {
      method: "POST",
      route: "/api/antigravity/install",
      auth: admin,
    });

    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ alreadyInstalled: true });
  });
});

describe("POST /api/antigravity/test", () => {
  it("marks the account connected and stores what the CLI accepts", async () => {
    const { user, session } = await signedIn({
      profileId: READY,
      connectionStatus: "connected",
    });

    const result = await callRoute(testRoute.POST, {
      method: "POST",
      route: "/api/antigravity/test",
      auth: session,
    });

    expect(result.data).toEqual({
      status: "connected",
      reason: null,
      capabilities: { image: true, embeddedContext: true },
    });
    const row = await stored(user.id);
    expect(row.antigravityConnectionStatus).toBe("connected");
    expect(row.antigravityConnectedAt).not.toBeNull();
  });

  it("reports auth_required when the CLI has no login for the profile", async () => {
    const { user, session } = await signedIn({
      profileId: "logged-out-1",
      connectionStatus: "connected",
    });

    const result = await callRoute(testRoute.POST, {
      method: "POST",
      route: "/api/antigravity/test",
      auth: session,
    });

    expect(result.data).toEqual({
      status: "auth_required",
      reason: "auth_required",
      capabilities: null,
    });
    expect((await stored(user.id)).antigravityConnectionStatus).toBe(
      "auth_required",
    );
  });

  it("reports not_set_up for a user who has no profile", async () => {
    const { session } = await signedIn();

    const result = await callRoute(testRoute.POST, {
      method: "POST",
      route: "/api/antigravity/test",
      auth: session,
    });

    expect(result.data).toEqual({
      status: "disconnected",
      reason: "not_set_up",
      capabilities: null,
    });
  });

  it("reports profile_missing when the profile folder is gone", async () => {
    const { session } = await signedIn({
      profileId: "prof-gone",
      connectionStatus: "connected",
    });

    const result = await callRoute(testRoute.POST, {
      method: "POST",
      route: "/api/antigravity/test",
      auth: session,
    });

    expect(result.data).toMatchObject({
      status: "error",
      reason: "profile_missing",
    });
  });

  it("does not probe and reports disconnected when profile is retained but disconnected", async () => {
    const { user, session } = await signedIn({
      profileId: READY,
      connectionStatus: "disconnected",
    });

    const result = await callRoute(testRoute.POST, {
      method: "POST",
      route: "/api/antigravity/test",
      auth: session,
    });

    expect(result.data).toEqual({
      status: "disconnected",
      reason: "not_set_up",
      capabilities: null,
    });
    const row = await stored(user.id);
    expect(row.antigravityConnectionStatus).toBe("disconnected");
    expect(row.antigravityConnectedAt).toBeNull();
  });

  it("does not probe and preserves auth_required when profile status is auth_required", async () => {
    const { user, session } = await signedIn({
      profileId: READY,
      connectionStatus: "auth_required",
    });

    const result = await callRoute(testRoute.POST, {
      method: "POST",
      route: "/api/antigravity/test",
      auth: session,
    });

    expect(result.data).toEqual({
      status: "auth_required",
      reason: "not_set_up",
      capabilities: null,
    });
    const row = await stored(user.id);
    expect(row.antigravityConnectionStatus).toBe("auth_required");
  });
});

describe("GET /api/antigravity/models", () => {
  it("lists the models the CLI offers, with the user's saved choice", async () => {
    const { session } = await signedIn({
      profileId: READY,
      model: "model-pro",
    });

    const result = await callRoute(modelsRoute.GET, {
      method: "GET",
      route: "/api/antigravity/models",
      auth: session,
    });

    expect(result.data).toEqual({
      models: [
        { id: "model-fast", name: "Fast" },
        { id: "model-pro", name: "Pro" },
      ],
      selectedModel: "model-pro",
      reason: null,
      thoughtLevels: null,
    });
  });

  it("reports not_set_up without starting the CLI for a user with no profile", async () => {
    const { session } = await signedIn();
    const before = fake.records().length;

    const result = await callRoute(modelsRoute.GET, {
      method: "GET",
      route: "/api/antigravity/models",
      auth: session,
    });

    expect(result.data).toMatchObject({ models: [], reason: "not_set_up" });
    expect(fake.records().length).toBe(before);
  });

  it("reports auth_required for a profile with no login", async () => {
    const { session } = await signedIn({ profileId: "logged-out-2" });

    const result = await callRoute(modelsRoute.GET, {
      method: "GET",
      route: "/api/antigravity/models",
      auth: session,
    });

    expect(result.data).toMatchObject({ models: [], reason: "auth_required" });
  });
});

describe("PATCH /api/antigravity/model", () => {
  it("saves the chosen model", async () => {
    const { user, session } = await signedIn({ profileId: READY });

    const result = await callRoute(modelRoute.PATCH, {
      method: "PATCH",
      route: "/api/antigravity/model",
      body: { model: "model-pro" },
      auth: session,
    });

    expect(result.data).toEqual({ selectedModel: "model-pro" });
    expect((await stored(user.id)).antigravityModel).toBe("model-pro");
  });

  it("clears the choice with null, back to the CLI default", async () => {
    const { user, session } = await signedIn({
      profileId: READY,
      model: "model-pro",
    });

    const result = await callRoute(modelRoute.PATCH, {
      method: "PATCH",
      route: "/api/antigravity/model",
      body: { model: null },
      auth: session,
    });

    expect(result.data).toEqual({ selectedModel: null });
    expect((await stored(user.id)).antigravityModel).toBeNull();
  });

  it("refuses a model id outside the CLI id format and saves nothing", async () => {
    const { user, session } = await signedIn({ profileId: READY });

    const result = await callRoute(modelRoute.PATCH, {
      method: "PATCH",
      route: "/api/antigravity/model",
      body: { model: "model; rm -rf /" },
      auth: session,
      contract: { skip: "422 refusals use the shared validation envelope" },
    });

    expect(result.status).toBe(422);
    expect((await stored(user.id)).antigravityModel).toBeNull();
  });

  it("refuses a choice when Antigravity is not set up", async () => {
    const { session } = await signedIn();

    const result = await callRoute(modelRoute.PATCH, {
      method: "PATCH",
      route: "/api/antigravity/model",
      body: { model: "model-pro" },
      auth: session,
      contract: { skip: "409 is an apiError envelope, not a declared schema" },
    });

    expect(result.status).toBe(409);
  });
});

describe("POST /api/antigravity/disconnect", () => {
  it("clears the profile, the model and the stored test result", async () => {
    mkdirSync(path.join(fake.profileRoot, GENERATED));
    const { user, session } = await signedIn({
      profileId: GENERATED,
      model: "model-pro",
      connectionStatus: "connected",
      connectedAt: new Date("2026-11-01T10:00:00Z"),
      capabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
      },
    });

    const result = await callRoute(disconnectRoute.POST, {
      method: "POST",
      route: "/api/antigravity/disconnect",
      auth: session,
    });

    expect(result.data).toEqual({ success: true, loginRemoved: true });
    // The login folder is gone, so the token no longer sits on the server.
    expect(existsSync(path.join(fake.profileRoot, GENERATED))).toBe(false);
    const row = await stored(user.id);
    expect(row.antigravityProfileId).toBeNull();
    expect(row.antigravityModel).toBeNull();
    expect(row.antigravityConnectionStatus).toBe("disconnected");
    expect(row.antigravityConnectedAt).toBeNull();
    expect(row.antigravityCapabilitiesJson).toBeNull();
  });
});
