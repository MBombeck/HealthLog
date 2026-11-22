import { describe, expect, it } from "vitest";
import { buildAuditLogQueryParams } from "../login-overview-section";

/**
 * The viewer pins `filter=auth` so the default view stays on sign-in
 * events, but an action picked from its own dropdown has to replace that
 * default: the server ANDs the two, and a non-auth action (a document
 * upload a guardian made inside a managed profile, #1403) answered zero
 * rows next to `filter=auth`.
 */
const base = {
  page: 1,
  perPage: 50,
  actor: "",
  actionFilter: "",
  target: "",
  range: "all" as const,
};

describe("buildAuditLogQueryParams", () => {
  it("restricts to auth events when no action is chosen", () => {
    const params = buildAuditLogQueryParams(base);
    expect(params.get("filter")).toBe("auth");
    expect(params.has("action")).toBe(false);
  });

  it("treats the dropdown's all-actions entry as no choice", () => {
    const params = buildAuditLogQueryParams({
      ...base,
      actionFilter: "__all__",
    });
    expect(params.get("filter")).toBe("auth");
    expect(params.has("action")).toBe(false);
  });

  it("lets a chosen action replace the auth-only default", () => {
    const params = buildAuditLogQueryParams({
      ...base,
      actionFilter: "documents.inbound.store",
    });
    expect(params.get("action")).toBe("documents.inbound.store");
    expect(params.has("filter")).toBe(false);
  });

  it("narrows to a whole family when one is picked (#1403)", () => {
    const params = buildAuditLogQueryParams({
      ...base,
      actionFilter: "family:documents",
    });
    expect(params.get("filter")).toBe("documents");
    expect(params.has("action")).toBe(false);
  });

  it("falls back to the auth default for a family it does not know", () => {
    const params = buildAuditLogQueryParams({
      ...base,
      actionFilter: "family:billing",
    });
    expect(params.get("filter")).toBe("auth");
    expect(params.has("action")).toBe(false);
  });

  it("carries the remaining filters through", () => {
    const params = buildAuditLogQueryParams({
      ...base,
      page: 2,
      perPage: 25,
      actor: "  parent ",
      target: " doc-1 ",
      range: "24h",
    });
    expect(params.get("page")).toBe("2");
    expect(params.get("perPage")).toBe("25");
    expect(params.get("actor")).toBe("parent");
    expect(params.get("target")).toBe("doc-1");
    expect(params.get("since")).not.toBeNull();
  });
});
