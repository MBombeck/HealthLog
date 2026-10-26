/**
 * Every web surface that calls a route behind the recent-proof gate asks for
 * the proof through `useRecentProof` and renders its dialog, so a person whose
 * session is older than five minutes is asked to confirm instead of meeting a
 * bare failure. Source-oriented, like the enrollment reauth test next door:
 * the repository keeps component tests free of a browser DOM harness. The
 * server half is pinned in `tests/integration/recent-proof.test.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-fetch";
import {
  ReproofCancelledError,
  recentProofErrorMessage,
  throwIfReproofRequired,
} from "../use-recent-proof";

const SRC = resolve(__dirname, "..", "..", "..", "..");
const read = (file: string) => readFileSync(resolve(SRC, file), "utf8");

describe("throwIfReproofRequired", () => {
  it("turns the refusal into an ApiError carrying the methods", async () => {
    const res = new Response(
      JSON.stringify({
        data: null,
        error: "Confirm it is you to continue",
        meta: { errorCode: "auth.reproof.required", methods: ["password"] },
      }),
      { status: 401 },
    );
    const err = await throwIfReproofRequired(res).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).meta?.methods).toEqual(["password"]);
  });

  it("passes every other response through untouched", async () => {
    const other = new Response(
      JSON.stringify({ meta: { errorCode: "auth.stepup.required" } }),
      { status: 401 },
    );
    await expect(throwIfReproofRequired(other)).resolves.toBe(other);
    const ok = new Response("{}", { status: 200 });
    await expect(throwIfReproofRequired(ok)).resolves.toBe(ok);
  });
});

describe("recentProofErrorMessage", () => {
  it("shows nothing for a cancelled dialog and the sentence for sign-in-again", () => {
    expect(recentProofErrorMessage(new ReproofCancelledError(), "x")).toBe(
      null,
    );
    expect(
      recentProofErrorMessage(
        new ApiError("Sign in again", 401, {
          errorCode: "auth.reproof.sign_in_again",
        }),
        "x",
      ),
    ).toBe("Sign in again");
    expect(recentProofErrorMessage(new Error("boom"), "fallback")).toBe(
      "fallback",
    );
  });
});

/**
 * [component, gated route, the hook that sends it]. The component holds the
 * flow and renders its dialog; the request runs through `recentProof.run`,
 * in the component itself or in a hook the component hands the flow to.
 */
describe.each<[string, string, string?]>([
  ["components/settings/export-section.tsx", "/api/export/full-backup"],
  ["components/settings/export-section.tsx", "/api/export/encrypted"],
  ["components/settings/share-link-create-form.tsx", "/api/share-links"],
  ["components/settings/mcp-section.tsx", "/api/mcp/tokens"],
  ["components/settings/api-section.tsx", "/api/tokens/measurements"],
  ["components/settings/api-section.tsx", "/api/tokens/documents"],
  ["components/settings/api-section.tsx", "/api/tokens/workouts"],
  [
    "components/admin/backups-section.tsx",
    "/download",
    "components/admin/backups/use-backup-actions.ts",
  ],
  [
    "components/admin/backups-section.tsx",
    "/restore",
    "components/admin/backups/use-backup-restores.ts",
  ],
  [
    "components/admin/backups-section.tsx",
    "/api/admin/backups/upload",
    "components/admin/backups/use-backup-upload.ts",
  ],
  ["components/admin/danger-zone-section.tsx", "/api/admin/data"],
  ["components/admin/user-management-section.tsx", "/reset-password"],
])("%s → %s", (file, endpoint, caller = file) => {
  const source = read(file);
  const calling = read(caller);

  it("calls the gated route", () => {
    expect(calling).toContain(endpoint);
  });

  it("runs it through the recent-proof hook and renders the dialog", () => {
    expect(source).toContain("useRecentProof()");
    expect(calling).toMatch(/recentProof\.run\(/);
    expect(source).toContain("{recentProof.dialog}");
    if (caller !== file) {
      // The component hands its flow to the hook that sends the request.
      const hook = caller
        .split("/")
        .pop()!
        .replace(/\.tsx?$/, "");
      expect(source).toMatch(new RegExp(`from "\\./[\\w/-]*${hook}"`));
      expect(source).toMatch(/\(recentProof\)/);
    }
  });
});
