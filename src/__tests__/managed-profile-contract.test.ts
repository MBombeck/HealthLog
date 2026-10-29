import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openApiPaths } from "@/lib/openapi/routes";

const root = process.cwd();

/** Every `route.ts` under the API tree. */
async function apiRouteFiles(): Promise<string[]> {
  const entries = await readdir(path.join(root, "src/app/api"), {
    recursive: true,
  });
  return entries
    .filter((entry) => entry.endsWith("route.ts"))
    .map((entry) => path.join("src/app/api", entry));
}

/** The published path a route file serves, or null when it is unpublished. */
function publishedPathFor(file: string): string | null {
  const apiPath = file
    .replace(/^src\/app/, "")
    .replace(/\/route\.ts$/, "")
    .replace(/\[([^\]]+)\]/g, "{$1}");
  return apiPath in openApiPaths ? apiPath : null;
}

describe("managed-profile contract", () => {
  it("publishes the last-Guardian refusal on every published route that emits it", async () => {
    // The failure this catches is the one the release audit found: the floor
    // is enforced on four surfaces and was DESCRIBED on the one route that
    // cannot reach it, while two routes that answer it every time said only
    // "that access had already ended". Emitters are discovered from the route
    // sources, so a fifth one cannot ship undescribed.
    const files = await apiRouteFiles();
    expect(files.length).toBeGreaterThan(100);

    const emitters: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(root, file), "utf8");
      if (!source.includes("LastManagedGuardianError")) continue;
      if (!source.includes("managed_profile.guardian.required")) continue;
      emitters.push(file);
    }
    // Non-zero, and known: the two grant routes. The lifecycle surfaces that
    // also raise it (account deletion, the data wipe) answer through their own
    // envelopes and are not in this spec.
    expect(emitters).toContain("src/app/api/account/grants/[id]/route.ts");
    expect(emitters).toContain(
      "src/app/api/account/grants/[id]/renounce/route.ts",
    );

    const silent = emitters.filter((file) => {
      const apiPath = publishedPathFor(file);
      if (apiPath === null) return false;
      return !JSON.stringify(openApiPaths[apiPath]).includes(
        "managed_profile.guardian.required",
      );
    });
    expect(
      silent,
      "published routes that emit the last-Guardian refusal without publishing it",
    ).toEqual([]);
  });

  it("requires a cookie-backed fresh MFA proof for creation", async () => {
    const source = await readFile(
      path.join(root, "src/app/api/managed-profiles/route.ts"),
      "utf8",
    );

    expect(source).toContain("requireFreshMfa");
    expect(source).not.toContain("requireFreshMfaIfEnrolled");
  });

  it("requires a cookie-backed fresh MFA proof for profile deletion", async () => {
    const source = await readFile(
      path.join(root, "src/app/api/managed-profiles/[id]/route.ts"),
      "utf8",
    );

    expect(source).toContain("requireFreshMfa");
    expect(source).not.toContain("requireFreshMfaIfEnrolled");
  });

  it("publishes no Guardian refusal a request cannot produce", async () => {
    // `managed_profile.guardian.self` was written, shipped and never
    // reachable: `self_grant` needs the grantor to equal the grantee, and the
    // grantor of a Guardian grant is the PROFILE. Inviting yourself lands on
    // the duplicate refusal; naming the profile is refused a step earlier as
    // `managed_grantee`. Both doors are asserted in
    // `tests/integration/managed-profile-surface.test.ts`, so the arm was
    // known to be dead rather than assumed to be, and it was removed rather
    // than frozen into the published contract.
    const route = await readFile(
      path.join(root, "src/app/api/managed-profiles/[id]/guardians/route.ts"),
      "utf8",
    );
    const spec = await readFile(
      path.join(root, "docs/api/openapi.yaml"),
      "utf8",
    );

    // Non-zero control: the codes that ARE reachable are still named, so this
    // cannot pass by matching an empty file or a renamed family.
    expect(route).toContain("managed_profile.guardian.duplicate");
    expect(route).toContain("managed_profile.guardian.managed_invitee");
    expect(route).not.toContain('errorCode: "managed_profile.guardian.self"');
    expect(spec).not.toContain("managed_profile.guardian.self");
  });

  it("does not publish an emancipation API surface", async () => {
    const source = await readFile(
      path.join(root, "prisma/schema.prisma"),
      "utf8",
    );

    expect(source.toLowerCase()).not.toContain("emancipation");

    const routes = await readdir(
      path.join(root, "src/app/api/managed-profiles"),
      { recursive: true },
    );
    expect(
      routes.some((entry) => entry.toLowerCase().includes("emancip")),
    ).toBe(false);
  });

  it("does not claim notification fanout before its consent plan exists", async () => {
    const source = await readFile(
      path.join(root, "prisma/schema.prisma"),
      "utf8",
    );

    expect(source).not.toContain("notification dispatcher fans reminders");
    expect(source).toContain("later notification plan");
  });

  it("uses the same record lock for every Guardian-reducing transition", async () => {
    const lifecycle = await readFile(
      path.join(root, "src/lib/managed-profiles/lifecycle.ts"),
      "utf8",
    );
    const grants = await readFile(
      path.join(root, "src/lib/sharing/grants.ts"),
      "utf8",
    );
    // Both account deletions (the account's own and an admin's) take the one
    // request path, and that path decides the Guardian invariant.
    const deletionRequest = await readFile(
      path.join(root, "src/lib/account-deletion/request.ts"),
      "utf8",
    );
    const deletionRoutes = await Promise.all(
      [
        "src/app/api/settings/account/route.ts",
        "src/app/api/admin/users/[id]/route.ts",
      ].map((rel) => readFile(path.join(root, rel), "utf8")),
    );

    expect(lifecycle).toContain("pg_advisory_xact_lock");
    expect(lifecycle).toContain("clearManagedProfileMarker");
    expect(lifecycle).toContain("deleteManagedProfile");
    expect(grants).toContain("reduceManagedProfileGuardian");
    expect(deletionRequest).toContain("deleteGuardianAccountWithLifecycle(");
    for (const route of deletionRoutes) {
      expect(route).toContain("requestAccountDeletion(");
      expect(route).not.toContain("lockAccountForDeletion(");
    }
  });
});
