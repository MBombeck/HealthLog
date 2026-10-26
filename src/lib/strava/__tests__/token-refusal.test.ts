/**
 * What Strava's token endpoint answers when it refuses, and what the sync
 * makes of it.
 *
 * Strava does not answer RFC 6749 errors. A refused refresh is the API's
 * generic `Fault`; the bodies below are the ones the endpoint sends, as
 * captured from live traffic by several unrelated client libraries (Strava
 * documents the `Fault` / `Error` model, not these particular values). The
 * HTTP layer is the only thing replaced: `postToken`, the error it throws and
 * the classifier all run as they do in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/safe-fetch", () => ({ safeFetch: vi.fn() }));

import { safeFetch } from "@/lib/safe-fetch";

import {
  classifyStravaError,
  stravaFaultSummary,
  StravaApiError,
} from "../response-classifier";
import { classifyStravaFailure } from "../sync";
import { stravaOAuth } from "../oauth";

const creds = { clientId: "12345", clientSecret: "not-a-real-secret" };

const DEAD_REFRESH_TOKEN = {
  message: "Bad Request",
  errors: [
    { resource: "RefreshToken", field: "refresh_token", code: "invalid" },
  ],
};
const BAD_CLIENT_ID = {
  message: "Bad Request",
  errors: [{ resource: "Application", field: "client_id", code: "invalid" }],
};
const BAD_CLIENT = {
  message: "Authorization Error",
  errors: [{ resource: "Application", field: "", code: "invalid" }],
};

function answer(status: number, body: unknown) {
  vi.mocked(safeFetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

async function refusal(run: () => Promise<unknown>): Promise<StravaApiError> {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StravaApiError);
  return err as StravaApiError;
}

beforeEach(() => {
  vi.mocked(safeFetch).mockReset();
});

describe("a refused Strava token request", () => {
  it("asks for a reconnect when the refresh token is dead", async () => {
    answer(400, DEAD_REFRESH_TOKEN);
    const err = await refusal(() => stravaOAuth.refresh("rt-dead", creds));

    expect(err.httpStatus).toBe(400);
    expect(err.upstreamError).toBe("RefreshToken.refresh_token:invalid");
    expect(classifyStravaError(err)).toBe("reauth_required");
    expect(classifyStravaFailure(err)).toBe("reauth_required");
  });

  it("still asks for a reconnect when the error lost its prototype on a retry", async () => {
    answer(400, DEAD_REFRESH_TOKEN);
    const err = await refusal(() => stravaOAuth.refresh("rt-dead", creds));
    const replayed = new Error(err.message);

    expect(replayed.message).toBe(
      "Strava refreshAccessToken error: 400 - RefreshToken.refresh_token:invalid",
    );
    expect(classifyStravaError(replayed)).toBe("reauth_required");
  });

  it("leaves a fault that names the application to the status, as before", async () => {
    // A client id or secret the instance holds wrongly. Whether Strava ever
    // answers a per-person condition this way is not documented, so the
    // status decides, as it always has: 400 persistent, 401 reconnect.
    answer(400, BAD_CLIENT_ID);
    const bad = await refusal(() => stravaOAuth.refresh("rt-live", creds));
    expect(bad.upstreamError).toBe("Application.client_id:invalid");
    expect(classifyStravaError(bad)).toBe("persistent");

    answer(401, BAD_CLIENT);
    const unauthorised = await refusal(() =>
      stravaOAuth.refresh("rt-live", creds),
    );
    expect(unauthorised.upstreamError).toBe("Application:invalid");
    expect(classifyStravaError(unauthorised)).toBe("reauth_required");
  });

  it("leaves a 400 that names neither as persistent and a 5xx as transient", async () => {
    answer(400, { message: "Bad Request", errors: [] });
    const plain = await refusal(() => stravaOAuth.exchange("code", creds));
    expect(plain.upstreamError).toBe("Bad Request");
    expect(classifyStravaError(plain)).toBe("persistent");

    answer(503, { message: "Service Unavailable" });
    const outage = await refusal(() => stravaOAuth.refresh("rt-live", creds));
    expect(classifyStravaError(outage)).toBe("transient");
  });

  it("still honours a standards-shaped invalid_grant", async () => {
    answer(400, { error: "invalid_grant" });
    const err = await refusal(() => stravaOAuth.refresh("rt-dead", creds));
    expect(err.upstreamError).toBe("invalid_grant");
    expect(classifyStravaError(err)).toBe("reauth_required");
  });
});

describe("stravaFaultSummary", () => {
  it("names only the resource, field and code, and drops anything else", () => {
    expect(
      stravaFaultSummary({
        message: "Bad Request",
        errors: [
          {
            resource: "RefreshToken",
            field: "refresh_token<script>",
            code: "invalid",
          },
        ],
      }),
    ).toBe("RefreshToken:invalid");
    expect(stravaFaultSummary(null)).toBeUndefined();
    expect(stravaFaultSummary({ errors: "nope" })).toBeUndefined();
  });
});
