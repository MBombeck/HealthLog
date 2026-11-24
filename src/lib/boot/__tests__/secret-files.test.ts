/**
 * `<NAME>_FILE` secrets: the loader's rules, and the hand-over to the shell
 * the entrypoint makes, run through a real `sh` with values that would break
 * any quoting short of the real thing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  SECRET_ENV_NAMES,
  SecretFileError,
  applySecretFiles,
  resolveSecretFiles,
  shellExports,
  shellQuote,
  stripOneTrailingNewline,
  unknownFileVariables,
} from "../secret-files.mjs";

const dir = mkdtempSync(join(tmpdir(), "secret-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function secretFile(content: string): string {
  const path = join(dir, `s${counter++}`);
  writeFileSync(path, content, "utf8");
  return path;
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretFileError);
    return (error as SecretFileError).problems;
  }
  throw new Error("expected a SecretFileError");
}

/** A bare environment for a child process: PATH and what the case sets. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, NODE_ENV: "test", ...extra };
}

/** Every character a shell could take for syntax, and a line break. */
const NASTY = `a'b"c$HOME \`id\` $(id) \\n\n;|&<>*?[x] !# '' end`;

describe("resolveSecretFiles", () => {
  it("does nothing when no _FILE variable is set, or one is empty", () => {
    expect(resolveSecretFiles({})).toEqual([]);
    expect(
      resolveSecretFiles({ ENCRYPTION_KEY_FILE: "", ENCRYPTION_KEY: "k" }),
    ).toEqual([]);
  });

  it("reads the file and strips exactly one trailing newline", () => {
    const env = {
      ENCRYPTION_KEY_FILE: secretFile("abc\n"),
      API_TOKEN_HMAC_KEY_FILE: secretFile("def\r\n"),
      SMTP_PASS_FILE: secretFile("two\n\n"),
      DATABASE_URL_FILE: secretFile("  spaced  "),
    };
    expect(resolveSecretFiles(env)).toEqual([
      { name: "DATABASE_URL", value: "  spaced  " },
      { name: "ENCRYPTION_KEY", value: "abc" },
      { name: "API_TOKEN_HMAC_KEY", value: "def" },
      { name: "SMTP_PASS", value: "two\n" },
    ]);
  });

  it("refuses a file that cannot be read, naming the variable and reason", () => {
    const missing = join(dir, "does-not-exist");
    expect(
      problemsOf(() => resolveSecretFiles({ ENCRYPTION_KEY_FILE: missing })),
    ).toEqual([`ENCRYPTION_KEY_FILE: cannot read ${missing} (ENOENT).`]);
    expect(
      problemsOf(() => resolveSecretFiles({ ENCRYPTION_KEY_FILE: dir })),
    ).toEqual([`ENCRYPTION_KEY_FILE: cannot read ${dir} (EISDIR).`]);
  });

  it("refuses an empty or whitespace-only file, and a NUL byte", () => {
    const empty = secretFile("");
    const newline = secretFile("\n");
    const blank = secretFile("   \n");
    const nul = secretFile("a\0b");
    expect(
      problemsOf(() =>
        resolveSecretFiles({
          DATABASE_URL_FILE: empty,
          ENCRYPTION_KEY_FILE: newline,
          API_TOKEN_HMAC_KEY_FILE: blank,
          SMTP_PASS_FILE: nul,
        }),
      ),
    ).toEqual([
      `DATABASE_URL_FILE: ${empty} is empty.`,
      `ENCRYPTION_KEY_FILE: ${newline} is empty.`,
      `API_TOKEN_HMAC_KEY_FILE: ${blank} is empty.`,
      `SMTP_PASS_FILE: ${nul} contains a NUL byte.`,
    ]);
  });

  it("accepts NAME set to the same value, refuses a different one", () => {
    const path = secretFile("same\n");
    expect(
      resolveSecretFiles({ ENCRYPTION_KEY: "same", ENCRYPTION_KEY_FILE: path }),
    ).toEqual([{ name: "ENCRYPTION_KEY", value: "same" }]);
    const problems = problemsOf(() =>
      resolveSecretFiles({
        ENCRYPTION_KEY: "other",
        ENCRYPTION_KEY_FILE: path,
      }),
    );
    expect(problems).toEqual([
      "ENCRYPTION_KEY and ENCRYPTION_KEY_FILE are both set, to different values. Set one of them.",
    ]);
  });

  it("never puts a value into a refusal", () => {
    const secret = "s3cr3t-value-that-must-not-leak";
    const problems = problemsOf(() =>
      resolveSecretFiles({
        ENCRYPTION_KEY: "different-plain-value",
        ENCRYPTION_KEY_FILE: secretFile(secret),
        SMTP_PASS_FILE: secretFile(`${secret}\0`),
      }),
    );
    expect(problems.join("\n")).not.toContain(secret);
    expect(problems.join("\n")).not.toContain("different-plain-value");
  });

  it("reports every unusable file at once", () => {
    expect(
      problemsOf(() =>
        resolveSecretFiles({
          ENCRYPTION_KEY_FILE: join(dir, "nope-1"),
          SMTP_PASS_FILE: join(dir, "nope-2"),
        }),
      ),
    ).toHaveLength(2);
  });

  it("ignores a _FILE variable for a name not on the list", () => {
    expect(resolveSecretFiles({ SMTP_USER_FILE: secretFile("user") })).toEqual(
      [],
    );
  });
});

describe("unknownFileVariables", () => {
  it("names a set _FILE variable that is not on the list", () => {
    expect(
      unknownFileVariables({
        SMTP_USER_FILE: "/x",
        ENCRYPTION_KEY_FILE: "/y",
        APNS_KEY_FILE: "/p8",
        SSL_CERT_FILE: "/ca",
        EMPTY_FILE: "",
        lower_FILE: "/z",
      }),
    ).toEqual(["SMTP_USER_FILE"]);
  });
});

describe("applySecretFiles", () => {
  it("sets NAME, removes NAME_FILE, and finds nothing the second time", () => {
    const env: Record<string, string | undefined> = {
      ENCRYPTION_KEY_FILE: secretFile("key\n"),
      SMTP_USER_FILE: "/left/alone",
    };
    expect(applySecretFiles(env)).toEqual(["ENCRYPTION_KEY"]);
    expect(env).toEqual({
      ENCRYPTION_KEY: "key",
      SMTP_USER_FILE: "/left/alone",
    });
    expect(applySecretFiles(env)).toEqual([]);
  });

  it("changes nothing when one file is unusable", () => {
    const env: Record<string, string | undefined> = {
      ENCRYPTION_KEY_FILE: secretFile("key"),
      SMTP_PASS_FILE: join(dir, "missing"),
    };
    const before = { ...env };
    expect(() => applySecretFiles(env)).toThrow(SecretFileError);
    expect(env).toEqual(before);
  });
});

describe("the hand-over to the shell", () => {
  it("strips one newline in either form", () => {
    expect(stripOneTrailingNewline("a\n")).toBe("a");
    expect(stripOneTrailingNewline("a\r\n")).toBe("a");
    expect(stripOneTrailingNewline("a\n\n")).toBe("a\n");
    expect(stripOneTrailingNewline("a\r")).toBe("a\r");
  });

  it("quotes a single quote as close, escaped quote, reopen", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellExports([{ name: "SMTP_PASS", value: "x" }])).toBe(
      "export SMTP_PASS='x'\nunset SMTP_PASS_FILE\n",
    );
  });

  it("round-trips any value through eval in a real sh", () => {
    const script =
      'eval "$1"; printf "%s" "$SMTP_PASS"; printf "|%s|" "${SMTP_PASS_FILE-unset}"';
    const run = spawnSync(
      "sh",
      ["-c", script, "sh", shellExports([{ name: "SMTP_PASS", value: NASTY }])],
      {
        encoding: "utf8",
        env: childEnv({ SMTP_PASS_FILE: "/x" }),
      },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${NASTY}|unset|`);
  });
});

describe("scripts/secret-files.mjs, as the entrypoint runs it", () => {
  const ENTRYPOINT_STEP = [
    'secret_exports="$(node scripts/secret-files.mjs export 3>&1 1>&2)" || exit 1',
    'eval "$secret_exports"',
    "unset secret_exports",
    'node -e "process.stdout.write(JSON.stringify({ smtp: process.env.SMTP_PASS, key: process.env.ENCRYPTION_KEY, file: process.env.SMTP_PASS_FILE ?? null }))"',
  ].join("\n");

  function entrypoint(env: Record<string, string>) {
    return spawnSync("sh", ["-c", ENTRYPOINT_STEP], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnv(env),
    });
  }

  it("hands the values over on descriptor 3 and nothing on stdout or stderr", () => {
    const run = entrypoint({
      SMTP_PASS_FILE: secretFile(`${NASTY}\n`),
      ENCRYPTION_KEY_FILE: secretFile("hex-key\r\n"),
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      smtp: NASTY,
      key: "hex-key",
      file: null,
    });
    expect(run.stderr).toContain("read from files: ENCRYPTION_KEY, SMTP_PASS");
    expect(run.stderr).not.toContain("hex-key");
    expect(run.stderr).not.toContain("$(id)");
  });

  it("stops the boot on an unusable file, value unprinted", () => {
    const run = entrypoint({
      ENCRYPTION_KEY: "plain-value",
      ENCRYPTION_KEY_FILE: secretFile("file-value"),
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(
      "ENCRYPTION_KEY and ENCRYPTION_KEY_FILE are both set",
    );
    expect(run.stderr).not.toContain("plain-value");
    expect(run.stderr).not.toContain("file-value");
  });

  it("warns about a _FILE variable it does not know and goes on", () => {
    const run = entrypoint({ SMTP_USER_FILE: "/whatever" });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("SMTP_USER_FILE is set, but SMTP_USER");
  });

  it("refuses to export without descriptor 3 rather than print a value", () => {
    const run = spawnSync("node", ["scripts/secret-files.mjs", "export"], {
      encoding: "utf8",
      env: childEnv({ SMTP_PASS_FILE: secretFile("never-printed") }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(run.status).toBe(1);
    expect(run.stdout + run.stderr).not.toContain("never-printed");
    expect(run.stderr).toContain("descriptor 3");
  });

  it("covers the names it says it covers", () => {
    // The list is what the rest of the file trusts; an empty one would
    // make every case above pass vacuously.
    expect(SECRET_ENV_NAMES).toContain("ENCRYPTION_KEY");
    expect(SECRET_ENV_NAMES).toContain("SMTP_PASS");
    expect(SECRET_ENV_NAMES).not.toContain("APNS_KEY");
  });
});
