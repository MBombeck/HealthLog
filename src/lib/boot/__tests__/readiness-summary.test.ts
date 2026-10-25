import { describe, it, expect } from "vitest";

import {
  collectReadiness,
  formatReadiness,
  logReadinessSummary,
} from "../readiness-summary";

const HEX32 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function baseEnv(): Record<string, string | undefined> {
  return {
    ENCRYPTION_KEY: HEX32,
    API_TOKEN_HMAC_KEY: HEX32,
    DATABASE_URL: "postgresql://healthlog:pw@db:5432/healthlog",
    NODE_ENV: "production",
  };
}

function lineFor(env: Record<string, string | undefined>, label: string) {
  return collectReadiness(env).lines.find((l) => l.label === label);
}

describe("collectReadiness — core secrets", () => {
  it("reports no blocker when the three core secrets are valid", () => {
    const report = collectReadiness(baseEnv());
    expect(report.hasBlocker).toBe(false);
    expect(lineFor(baseEnv(), "ENCRYPTION_KEY")?.status).toBe("ok");
    expect(lineFor(baseEnv(), "API_TOKEN_HMAC_KEY")?.status).toBe("ok");
    expect(lineFor(baseEnv(), "DATABASE_URL")?.status).toBe("ok");
  });

  it("flags a missing ENCRYPTION_KEY as a blocker with the openssl fix", () => {
    const env = baseEnv();
    delete env.ENCRYPTION_KEY;
    const report = collectReadiness(env);
    expect(report.hasBlocker).toBe(true);
    const line = report.lines.find((l) => l.label === "ENCRYPTION_KEY");
    expect(line?.status).toBe("error");
    expect(line?.detail).toContain("openssl rand -hex 32");
  });

  it("flags a too-short ENCRYPTION_KEY as a blocker", () => {
    const env = baseEnv();
    env.ENCRYPTION_KEY = "deadbeef";
    expect(collectReadiness(env).hasBlocker).toBe(true);
  });

  it("accepts the ENCRYPTION_KEYS rotation map instead of the single key", () => {
    const env = baseEnv();
    delete env.ENCRYPTION_KEY;
    env.ENCRYPTION_KEYS = JSON.stringify({ v1: HEX32, v2: HEX32 });
    const report = collectReadiness(env);
    expect(report.hasBlocker).toBe(false);
    expect(
      report.lines.find((l) => l.label === "ENCRYPTION_KEYS")?.status,
    ).toBe("ok");
  });

  it("flags a malformed ENCRYPTION_KEYS map", () => {
    const env = baseEnv();
    delete env.ENCRYPTION_KEY;
    env.ENCRYPTION_KEYS = '{"v1":"nothex"}';
    expect(collectReadiness(env).hasBlocker).toBe(true);
  });

  it("flags a missing DATABASE_URL", () => {
    const env = baseEnv();
    delete env.DATABASE_URL;
    expect(collectReadiness(env).hasBlocker).toBe(true);
  });
});

describe("collectReadiness — transport + optional", () => {
  it("warns Secure-on when NODE_ENV=production and no override", () => {
    const line = lineFor(baseEnv(), "SESSION_COOKIE_SECURE");
    expect(line?.detail).toContain("Secure cookie flag ON");
  });

  it("notes Secure-off when SESSION_COOKIE_SECURE=false", () => {
    const env = { ...baseEnv(), SESSION_COOKIE_SECURE: "false" };
    expect(lineFor(env, "SESSION_COOKIE_SECURE")?.detail).toContain(
      "Secure cookie flag OFF",
    );
  });

  it("marks optional subsystems as warn when unconfigured", () => {
    const smtp = lineFor(baseEnv(), "SMTP (email)");
    expect(smtp?.status).toBe("warn");
  });

  it("marks off-host backup ok only when every required var is set", () => {
    const env = {
      ...baseEnv(),
      BACKUP_S3_ENDPOINT: "https://r2",
      BACKUP_S3_BUCKET: "b",
      BACKUP_S3_ACCESS_KEY: "a",
      BACKUP_S3_SECRET_KEY: "s",
      BACKUP_ENCRYPTION_KEY: HEX32,
    };
    expect(lineFor(env, "Off-host backup")?.status).toBe("ok");
  });
});

describe("formatReadiness + logReadinessSummary", () => {
  it("renders a header that flags a blocker", () => {
    const env = baseEnv();
    delete env.API_TOKEN_HMAC_KEY;
    const text = formatReadiness(collectReadiness(env));
    expect(text).toContain("CORE SECRET MISSING/INVALID");
    expect(text).toContain("✗ API_TOKEN_HMAC_KEY");
  });

  it("logs blockers to error and healthy summaries to log; never throws", () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const sink = {
      error: (m: string) => errors.push(m),
      log: (m: string) => logs.push(m),
    };
    logReadinessSummary(baseEnv(), sink);
    expect(logs).toHaveLength(1);
    expect(errors).toHaveLength(0);

    const bad = baseEnv();
    delete bad.ENCRYPTION_KEY;
    logReadinessSummary(bad, sink);
    expect(errors).toHaveLength(1);
  });
});

describe("collectReadiness — retired AI grant", () => {
  it("warns, without blocking, when ALLOW_LOCAL_AI_PRIVATE_HOSTS is still `true`", () => {
    const env = { ...baseEnv(), ALLOW_LOCAL_AI_PRIVATE_HOSTS: " TRUE " };
    const line = lineFor(env, "ALLOW_LOCAL_AI_PRIVATE_HOSTS");
    expect(line?.status).toBe("warn");
    expect(line?.detail).toContain("AI_PRIVATE_ORIGINS");
    expect(collectReadiness(env).hasBlocker).toBe(false);
  });

  it("says nothing for a host list or an unset variable", () => {
    expect(
      lineFor(
        { ...baseEnv(), ALLOW_LOCAL_AI_PRIVATE_HOSTS: "ollama.lan" },
        "ALLOW_LOCAL_AI_PRIVATE_HOSTS",
      ),
    ).toBeUndefined();
    expect(lineFor(baseEnv(), "ALLOW_LOCAL_AI_PRIVATE_HOSTS")).toBeUndefined();
  });
});

describe("collectReadiness — the database dump", () => {
  const offhost = {
    BACKUP_S3_ENDPOINT: "https://s3.example.test",
    BACKUP_S3_BUCKET: "b",
    BACKUP_S3_ACCESS_KEY: "a",
    BACKUP_S3_SECRET_KEY: "s",
    BACKUP_ENCRYPTION_KEY: HEX32,
  };
  const dumpLine = (
    env: Record<string, string | undefined>,
    writable: boolean,
  ) =>
    collectReadiness(env, () => writable).lines.find(
      (l) => l.label === "Database dump",
    );

  it("names the schedule, the directory and the copies kept", () => {
    const line = dumpLine(baseEnv(), true);
    expect(line?.status).toBe("ok");
    expect(line?.detail).toBe(
      "nightly (30 1 * * *) into /var/lib/healthlog/backups, keeping 7",
    );
    expect(dumpLine({ ...baseEnv(), ...offhost }, true)?.detail).toContain(
      "copied off-host",
    );
  });

  it("warns when nothing can be kept on the server", () => {
    expect(dumpLine({ ...baseEnv(), ...offhost }, false)).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("goes off-host only"),
    });
    expect(dumpLine(baseEnv(), false)).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("no database dump can be taken"),
    });
  });

  it("warns when it is switched off, and names a schedule it ignored", () => {
    expect(
      dumpLine({ ...baseEnv(), DB_BACKUP_ENABLED: "false" }, true),
    ).toMatchObject({ status: "warn" });
    const report = collectReadiness(
      { ...baseEnv(), DB_BACKUP_SCHEDULE: "nightly" },
      () => true,
    );
    expect(
      report.lines.find((l) => l.label === "DB_BACKUP_SCHEDULE")?.detail,
    ).toBe("not a five-field cron; using 30 1 * * *");
    expect(report.hasBlocker).toBe(false);
  });
});
