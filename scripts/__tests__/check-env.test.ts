/**
 * v1.4.42 W6 — env-check sanity tests.
 *
 * The script's two pure helpers (`parseEnvFile` + `checkEnv`) are
 * pinned here. The renderResults / main() entrypoint is intentionally
 * not unit-tested — it's a thin shell over the pure helpers and the
 * exit-code behaviour is best left to a smoke test in CI (deferred to
 * v1.4.43).
 */
import { describe, expect, it } from "vitest";
import { checkEnv, parseEnvFile } from "../check-env";

describe("parseEnvFile", () => {
  it("parses simple KEY=VALUE pairs", () => {
    expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("strips surrounding double quotes", () => {
    expect(parseEnvFile('FOO="bar baz"')).toEqual({ FOO: "bar baz" });
  });

  it("strips surrounding single quotes", () => {
    expect(parseEnvFile("FOO='bar baz'")).toEqual({ FOO: "bar baz" });
  });

  it("skips comments and blank lines", () => {
    const src = `# header comment
FOO=bar

# another
BAZ=qux
`;
    expect(parseEnvFile(src)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("preserves an empty value (the v1.4.40 .p8 gap pattern)", () => {
    // An empty string MUST round-trip as "" so the presence-check
    // downstream classifies it as missing.
    expect(parseEnvFile("APNS_KEY=")).toEqual({ APNS_KEY: "" });
  });

  it("handles CRLF line endings (Coolify exports use \\r\\n)", () => {
    expect(parseEnvFile("FOO=bar\r\nBAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });
});

const SAMPLE_MANIFEST = {
  description: "test manifest",
  groups: [
    {
      name: "Core",
      description: "required boot vars",
      required: true,
      variables: [
        { name: "DATABASE_URL", purpose: "db" },
        { name: "ENCRYPTION_KEY", purpose: "crypto" },
      ],
    },
    {
      name: "APNs",
      description: "iOS push",
      required: false,
      allOrNone: true,
      variables: [
        { name: "APNS_KEY_ID", purpose: "key id" },
        { name: "APNS_TEAM_ID", purpose: "team id" },
        {
          name: "APNS_KEY",
          purpose: "key body or file",
          anyOf: ["APNS_KEY", "APNS_KEY_FILE"],
        },
      ],
    },
    {
      name: "Backups",
      description: "all-or-none",
      required: false,
      allOrNone: true,
      variables: [
        { name: "BACKUP_S3_BUCKET", purpose: "bucket" },
        { name: "BACKUP_S3_ACCESS_KEY", purpose: "key" },
      ],
    },
  ],
};

describe("checkEnv — required group", () => {
  it("flags every missing required var", () => {
    const out = checkEnv(SAMPLE_MANIFEST, {});
    const required = out.filter((r) => r.required && !r.present);
    expect(required.map((r) => r.variable)).toEqual([
      "DATABASE_URL",
      "ENCRYPTION_KEY",
    ]);
  });

  it("classifies whitespace-only values as missing (deploy-failure prevention)", () => {
    // A `DATABASE_URL="   "` would silently boot with a useless value;
    // the deployer expects to see a clear MISSING-REQUIRED row here.
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "   ",
      ENCRYPTION_KEY: "ok",
    });
    const row = out.find((r) => r.variable === "DATABASE_URL")!;
    expect(row.present).toBe(false);
    expect(row.required).toBe(true);
  });

  it("greenlights when every required var is non-empty", () => {
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "postgresql://x",
      ENCRYPTION_KEY: "deadbeef".repeat(8),
    });
    const required = out.filter((r) => r.required);
    expect(required.every((r) => r.present)).toBe(true);
  });
});

describe("checkEnv — anyOf alternatives", () => {
  it("treats APNS_KEY as satisfied when APNS_KEY_FILE is set instead", () => {
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
      APNS_KEY_ID: "abc",
      APNS_TEAM_ID: "def",
      APNS_KEY_FILE: "/secrets/apns.p8",
    });
    const apnsKey = out.find((r) => r.variable === "APNS_KEY")!;
    expect(apnsKey.present).toBe(true);
  });

  it("records satisfiedBy when an anyOf alternative satisfies the row", () => {
    // The label `[OK] APNS_KEY` was misleading pre-v1.4.42 — an operator
    // who saw it would grep for `APNS_KEY` in the env block and find
    // nothing, file a ghost issue. `satisfiedBy` lets the renderer
    // surface the alternative that actually matched.
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
      APNS_KEY_ID: "abc",
      APNS_TEAM_ID: "def",
      APNS_KEY_FILE: "/secrets/apns.p8",
    });
    const apnsKey = out.find((r) => r.variable === "APNS_KEY")!;
    expect(apnsKey.satisfiedBy).toBe("APNS_KEY_FILE");
  });

  it("leaves satisfiedBy undefined when the primary name is the one set", () => {
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
      APNS_KEY_ID: "abc",
      APNS_TEAM_ID: "def",
      APNS_KEY: "-----BEGIN PRIVATE KEY-----...",
    });
    const apnsKey = out.find((r) => r.variable === "APNS_KEY")!;
    expect(apnsKey.satisfiedBy).toBeUndefined();
  });

  it("treats APNS_KEY as satisfied when APNS_KEY is set (the 12-factor variant)", () => {
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
      APNS_KEY_ID: "abc",
      APNS_TEAM_ID: "def",
      APNS_KEY: "-----BEGIN PRIVATE KEY-----...",
    });
    expect(out.find((r) => r.variable === "APNS_KEY")?.present).toBe(true);
  });

  it("marks APNS_KEY missing when BOTH alternatives are absent (the v1.4.40 AP-2 gap)", () => {
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
      APNS_KEY_ID: "abc",
      APNS_TEAM_ID: "def",
    });
    expect(out.find((r) => r.variable === "APNS_KEY")?.present).toBe(false);
  });
});

describe("checkEnv — all-or-none groups", () => {
  it("emits a synthetic <all-or-none> required row when a group is half-populated", () => {
    // The v1.4.40 AP-2 silent-disable pattern: 3 of 4 APNS_* set, .p8
    // missing → app silently falls back to Telegram. The all-or-none
    // synthetic row catches this even when the surrounding group is
    // `required: false`.
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
      BACKUP_S3_BUCKET: "my-bucket",
      // BACKUP_S3_ACCESS_KEY deliberately absent
    });
    const synth = out.find((r) => r.variable === "<all-or-none>")!;
    expect(synth).toBeDefined();
    expect(synth.required).toBe(true);
    expect(synth.note).toContain("1/2");
  });

  it("does NOT emit the synthetic row when the group is fully set", () => {
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
      BACKUP_S3_BUCKET: "my-bucket",
      BACKUP_S3_ACCESS_KEY: "key",
    });
    expect(out.find((r) => r.variable === "<all-or-none>")).toBeUndefined();
  });

  it("does NOT emit the synthetic row when the group is fully empty", () => {
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
    });
    expect(out.find((r) => r.variable === "<all-or-none>")).toBeUndefined();
  });

  it("catches the v1.4.40 AP-2 scenario — 3 of 4 APNS_* set, key missing", () => {
    // Direct regression pin for the gap the env-check wave was conceived
    // to close. Pre-v1.4.42 the APNs group lacked `allOrNone: true` so
    // this exact env-block shape exited 0 and silently disabled APNs.
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
      APNS_KEY_ID: "abc",
      APNS_TEAM_ID: "def",
      // APNS_KEY / APNS_KEY_FILE deliberately absent
    });
    const synth = out.find(
      (r) => r.group === "APNs" && r.variable === "<all-or-none>",
    )!;
    expect(synth).toBeDefined();
    expect(synth.required).toBe(true);
    expect(synth.note).toContain("2/3");
  });
});

describe("checkEnv — optional groups (informational)", () => {
  it("reports optional vars without setting required: true", () => {
    const out = checkEnv(SAMPLE_MANIFEST, {
      DATABASE_URL: "x",
      ENCRYPTION_KEY: "y",
    });
    const apnsKeyId = out.find((r) => r.variable === "APNS_KEY_ID")!;
    expect(apnsKeyId.present).toBe(false);
    expect(apnsKeyId.required).toBe(false);
  });
});
