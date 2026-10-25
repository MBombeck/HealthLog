/**
 * Doc ↔ code parity guard for the Google Health operator runbook.
 *
 * The setup-guide link on the Settings card sends a mid-setup user to
 * `docs.healthlog.dev/guides/connect-google-health/`; the operator runbook in
 * this repository is `docs/integrations/google-health.md`. If the client ever requests a scope the
 * runbook doesn't list, or the walkthrough regresses back to a wrong provider
 * (the file was once a Fitbit-Web-API walkthrough), a self-hoster follows a
 * broken recipe and the OAuth consent screen rejects the connection.
 *
 * This test pins the doc to the code: every core scope the client requests must
 * appear verbatim in the runbook, alongside the real Google OAuth endpoints, the
 * fixed callback path, and the Google Cloud console setup. It also asserts the
 * provider key is wired into the setup-guide link so the card actually points
 * here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GOOGLE_HEALTH_CORE_SCOPES } from "@/lib/google-health/oauth";
import {
  DOCS_GUIDES_BASE,
  integrationDocsHref,
} from "@/components/settings/integrations/setup-guide-link";

const ROOT = join(__dirname, "../../../..");
const DOC_PATH = join(ROOT, "docs/integrations/google-health.md");
const doc = readFileSync(DOC_PATH, "utf8");

describe("google-health setup runbook parity", () => {
  it("mentions every core Restricted scope the client requests", () => {
    for (const scope of GOOGLE_HEALTH_CORE_SCOPES) {
      expect(doc).toContain(scope);
    }
  });

  it("documents the real Google OAuth endpoints", () => {
    expect(doc).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(doc).toContain("https://oauth2.googleapis.com/token");
  });

  it("documents the fixed callback path", () => {
    expect(doc).toContain("/api/google-health/callback");
  });

  it("walks the Google Cloud console setup (not the retired Fitbit walkthrough)", () => {
    expect(doc).toContain("console.cloud.google.com");
    expect(doc.toLowerCase()).toContain("google health api");
    // Guard against the pre-rewrite Fitbit-developer-console walkthrough
    // creeping back in.
    expect(doc).not.toContain("dev.fitbit.com");
    expect(doc).not.toContain("api.fitbit.com");
  });

  it("documents the honest data + re-consent caveats", () => {
    const lower = doc.toLowerCase();
    expect(lower).toContain("stress");
    expect(lower).toContain("readiness");
    expect(doc).toContain("7-day");
    expect(doc).toContain("GOOGLE_HEALTH_REDIRECT_URI");
  });

  it("names the 100-user / CASA verification ceiling", () => {
    expect(doc).toContain("100 users");
    expect(doc).toContain("CASA");
  });

  it("resolves the setup-guide href for the google-health provider", () => {
    // The literal argument also compile-checks that "google-health" is a member
    // of the IntegrationDocsProvider union.
    expect(integrationDocsHref("google-health")).toBe(
      `${DOCS_GUIDES_BASE}/connect-google-health/`,
    );
  });
});
