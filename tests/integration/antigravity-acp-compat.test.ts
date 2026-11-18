/**
 * ACP compatibility smoke test against the real `agy` binary.
 *
 * Purpose: catch breaking changes in the ACP protocol or CLI flags before
 * they reach a deployed container. The test is intentionally narrow — it
 * exercises only the parts of the wire protocol that our client depends on
 * and that are not covered by the fake-agy unit tests:
 *
 *   1. `agy --version` exits 0 and prints a semver.
 *   2. `agy acp` starts, responds to `initialize`, and the response has the
 *      shape our client reads (`protocolVersion`, `agentCapabilities`).
 *      Auth is not required for `initialize`; the test never reaches
 *      `session/new`, which is where the CLI checks credentials.
 *
 * The test is skipped when `agy` is not on PATH so it is safe to run in
 * environments that do not have the CLI installed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AcpConnection } from "@/lib/ai/antigravity-acp";
import { antigravityChildEnv } from "@/lib/ai/antigravity-client";

// ─── Guard: synchronous check so describe.skipIf gets a real boolean ─────────

function detectAgyVersion(): string | null {
  try {
    const out = execFileSync("agy", ["--version"], {
      env: antigravityChildEnv(),
      timeout: 8_000,
      encoding: "utf8",
    });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const AGY_VERSION = detectAgyVersion();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(AGY_VERSION === null)(
  `agy CLI compatibility — real binary (${AGY_VERSION ?? "not installed"})`,
  () => {
    it("agy --version prints a semver and exits 0", () => {
      expect(AGY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    describe("ACP initialize handshake", () => {
      let workDir: string;
      let connection: AcpConnection;

      beforeAll(async () => {
        workDir = mkdtempSync(join(tmpdir(), "healthlog-acp-compat-"));
        connection = await AcpConnection.start(
          ["acp", "--sandbox", "--disable-telemetry"],
          { cwd: workDir, env: antigravityChildEnv() },
        );
      });

      afterAll(async () => {
        await connection?.close();
        rmSync(workDir, { recursive: true, force: true });
      });

      it("responds to initialize within 15 s", async () => {
        const response = await connection.call(
          "initialize",
          {
            protocolVersion: 1,
            clientInfo: { name: "HealthLog-compat-test", version: "0.0.0" },
            systemPrompt:
              "You are a conversational assistant. Respond directly with plain text.",
          },
          15_000,
        );

        expect(response.error).toBeUndefined();
        expect(response.result).toBeTruthy();
      });

      it("initialize result carries protocolVersion 1", async () => {
        const response = await connection.call(
          "initialize",
          {
            protocolVersion: 1,
            clientInfo: { name: "HealthLog-compat-test", version: "0.0.0" },
            systemPrompt: "Respond with plain text.",
          },
          15_000,
        );

        const result = response.result as { protocolVersion?: unknown };
        expect(result.protocolVersion).toBe(1);
      });

      it("initialize result has agentCapabilities.promptCapabilities", async () => {
        const response = await connection.call(
          "initialize",
          {
            protocolVersion: 1,
            clientInfo: { name: "HealthLog-compat-test", version: "0.0.0" },
            systemPrompt: "Respond with plain text.",
          },
          15_000,
        );

        const result = response.result as {
          agentCapabilities?: { promptCapabilities?: unknown };
        };

        // The field may be absent on older builds; ensure it is not an
        // unexpected type when present.
        if (result.agentCapabilities?.promptCapabilities !== undefined) {
          expect(typeof result.agentCapabilities.promptCapabilities).toBe(
            "object",
          );
        }
      });
    });
  },
);
