import { describe, expect, it } from "vitest";

import { auditActionFamily, groupAuditActions } from "../audit-families";

describe("audit action families (#1403)", () => {
  it("places each action by its prefix, and leaves the rest out", () => {
    expect(auditActionFamily("auth.login")).toBe("auth");
    expect(auditActionFamily("documents.inbound.store")).toBe("documents");
    expect(auditActionFamily("sharing.record.accessed")).toBe("sharing");
    expect(auditActionFamily("managed_profile.create")).toBe("sharing");
    expect(auditActionFamily("share-link.create")).toBe("sharing");
    expect(auditActionFamily("medication.intake")).toBe("medication");
    expect(auditActionFamily("medications.intake.update")).toBe("medication");
    expect(auditActionFamily("insights.weight-status.en")).toBeNull();
    expect(auditActionFamily("authx.login")).toBeNull();
  });

  it("groups the table's own actions in family order", () => {
    expect(
      groupAuditActions([
        "medication.create",
        "documents.inbound.store",
        "insights.bmi-status.en",
        "auth.logout",
        "auth.login",
        "documents.inbound.delete",
      ]),
    ).toEqual([
      { family: "auth", actions: ["auth.login", "auth.logout"] },
      {
        family: "documents",
        actions: ["documents.inbound.delete", "documents.inbound.store"],
      },
      { family: "medication", actions: ["medication.create"] },
    ]);
  });
});
