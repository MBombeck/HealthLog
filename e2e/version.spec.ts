import { expect, test } from "@playwright/test";

/**
 * /api/version is the public, unauthenticated endpoint that drives
 * the Settings → About surface and acts as the container's healthcheck
 * target. If this breaks, every deployed image's healthcheck fails and
 * Coolify pulls the container out of rotation.
 */
test.describe("public version endpoint", () => {
  test("returns the running version + license", async ({ request }) => {
    const res = await request.get("/api/version");
    expect(res.status()).toBe(200);

    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(typeof json.data.version).toBe("string");
    expect(json.data.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(json.data.license).toBeDefined();
  });

  test("does not require authentication", async ({ request }) => {
    // No cookie, no Authorization header — must still respond 200 so
    // the docker healthcheck and the in-app "check for updates" button
    // both work without a session.
    const res = await request.get("/api/version", {
      headers: { "X-Client-Type": "anonymous" },
    });
    expect(res.status()).toBe(200);
  });
});
