import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  sessionOptionsDisabled: () =>
    process.env.DATABASE_SESSION_OPTIONS_DISABLED === "1",
}));

import {
  MAINTENANCE_SESSION_OPTIONS,
  maintenanceSessionStatements,
} from "@/lib/jobs/measurement-maintenance";

describe("maintenance session settings behind a pooler", () => {
  afterEach(() => {
    delete process.env.DATABASE_SESSION_OPTIONS_DISABLED;
  });

  it("restates every startup option as one SET statement", () => {
    const statements = maintenanceSessionStatements();
    const optionCount = MAINTENANCE_SESSION_OPTIONS.match(/-c /g)?.length;
    expect(statements).toHaveLength(optionCount ?? 0);
    expect(statements).toEqual([
      "SET statement_timeout = '0'",
      "SET idle_in_transaction_session_timeout = '0'",
      "SET maintenance_work_mem = '128MB'",
      "SET lock_timeout = '300000'",
    ]);
  });
});
