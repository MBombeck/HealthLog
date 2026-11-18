/**
 * A stand-in for the `agy` binary, used by the Antigravity integration tests.
 *
 * `installFakeAgy` writes an executable `agy` script and puts its folder first
 * on PATH. The client then starts it as a real child process, speaking ACP over
 * stdio, with the same arguments and the same allowlisted environment as the
 * real CLI. The script records what it was started with and what it was asked
 * to do, in a JSON-lines file. It answers with the profile name, so a test can
 * tell which profile produced a reply. No request reaches Google.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type FakeAgyRecord =
  | {
      kind: "start";
      appDataDir: string | null;
      geminiDir: string | null;
      cwd: string;
      envKeys: string[];
    }
  | { kind: "model"; value: string }
  | { kind: "permission"; outcome: unknown };

export interface FakeAgy {
  /** The profile root the client gets as `--gemini-dir`. */
  profileRoot: string;
  records(): FakeAgyRecord[];
  reset(): void;
  restorePath(): void;
  cleanup(): void;
}

/** Permission request id the script sends. Any id the client does not use. */
const PERMISSION_REQUEST_ID = 9001;

function scriptFor(recordFile: string): string {
  return `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const RECORD_FILE = ${JSON.stringify(recordFile)};
const PERMISSION_REQUEST_ID = ${PERMISSION_REQUEST_ID};
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const appDataDir = flag("--app-data-dir");
const geminiDir = flag("--gemini-dir");
// The client passes only --gemini-dir, the profile folder. A profile whose
// folder name starts with "logged-out" has no login.
const profileName = geminiDir === null ? "" : path.basename(geminiDir);
const loggedOut = profileName.indexOf("logged-out") === 0;
if (args.indexOf("--version") !== -1) {
  process.stdout.write("agy version 1.5.8\\n");
  process.exit(0);
}
const sessionId = "session-" + (appDataDir || "none");
let pendingPromptId = null;

function record(entry) {
  fs.appendFileSync(RECORD_FILE, JSON.stringify(entry) + "\\n");
}
function send(message) {
  process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: "2.0" }, message)) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);

  if (msg.id === PERMISSION_REQUEST_ID && msg.method === undefined) {
    record({ kind: "permission", outcome: msg.result && msg.result.outcome });
    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "profile:" + profileName },
        },
      },
    });
    send({ id: pendingPromptId, result: { stopReason: "end_turn" } });
    return;
  }

  switch (msg.method) {
    case "initialize":
      record({
        kind: "start",
        appDataDir,
        geminiDir,
        cwd: process.cwd(),
        envKeys: Object.keys(process.env).sort(),
      });
      send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "Fake agy" },
          agentCapabilities: {
            promptCapabilities: { image: true, embeddedContext: true },
          },
        },
      });
      return;
    case "session/new":
      if (loggedOut) {
        send({
          id: msg.id,
          error: { code: -32000, message: "Authentication required" },
        });
        return;
      }
      send({
        id: msg.id,
        result: {
          sessionId,
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "model-fast",
              options: [
                { value: "model-fast", name: "Fast" },
                { value: "model-pro", name: "Pro" },
              ],
            },
          ],
        },
      });
      return;
    case "session/set_config_option":
      record({ kind: "model", value: msg.params.value });
      send({ id: msg.id, result: { configOptions: [] } });
      return;
    case "session/prompt":
      pendingPromptId = msg.id;
      send({
        id: PERMISSION_REQUEST_ID,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tool-1", title: "Read a file" },
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow" },
            { optionId: "reject-once", kind: "reject_once", name: "Reject" },
          ],
        },
      });
      return;
    default:
      if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
});
`;
}

/** Install the fake `agy` on PATH and point ANTIGRAVITY_PROFILE_ROOT at a fresh folder. */
export function installFakeAgy(): FakeAgy {
  const root = mkdtempSync(path.join(tmpdir(), "healthlog-fake-agy-"));
  const binDir = path.join(root, "bin");
  const profileRoot = path.join(root, "profiles");
  const recordFile = path.join(root, "records.jsonl");
  mkdirSync(binDir);
  mkdirSync(profileRoot);

  const agyPath = path.join(binDir, "agy");
  writeFileSync(agyPath, scriptFor(recordFile));
  chmodSync(agyPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  const originalRoot = process.env.ANTIGRAVITY_PROFILE_ROOT;
  process.env.ANTIGRAVITY_PROFILE_ROOT = profileRoot;
  // The app looks for the binary by path, not on PATH. Point it at the fake too.
  const originalBin = process.env.ANTIGRAVITY_BIN_PATH;
  process.env.ANTIGRAVITY_BIN_PATH = agyPath;

  return {
    profileRoot,
    records() {
      if (!existsSync(recordFile)) return [];
      return readFileSync(recordFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as FakeAgyRecord);
    },
    reset() {
      rmSync(recordFile, { force: true });
    },
    restorePath() {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    },
    cleanup() {
      this.restorePath();
      if (originalBin === undefined) delete process.env.ANTIGRAVITY_BIN_PATH;
      else process.env.ANTIGRAVITY_BIN_PATH = originalBin;
      if (originalRoot === undefined)
        delete process.env.ANTIGRAVITY_PROFILE_ROOT;
      else process.env.ANTIGRAVITY_PROFILE_ROOT = originalRoot;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
