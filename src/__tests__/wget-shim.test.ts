/**
 * The image's `wget` answers the health checks written outside this
 * repository the way wget would.
 *
 * The runtime base carries no wget. A compose file copied from this
 * repository up to v1.46.6 checks health with
 * `wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health`,
 * and the TrueNAS catalog app renders `wget --quiet --spider <url>`; either
 * replaces the image's own HEALTHCHECK. Without a `wget` such a container is
 * unhealthy forever and a proxy that routes on health drops its traffic. So
 * the image installs `scripts/wget-shim.mjs` as `/usr/local/bin/wget`, and
 * this file runs that script as the health check would: exit 0 on a healthy
 * answer, 1 on a 503, a refused connection or a timeout, and no file
 * written anywhere.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readSource } from "./helpers/source-files";

const ROOT = process.cwd();
const SHIM = join(ROOT, "scripts", "wget-shim.mjs");

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
    } else if (req.url === "/down") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"status":"degraded"}');
    } else if (req.url === "/moved") {
      res.writeHead(302, { location: "http://192.0.2.1/elsewhere" });
      res.end();
    } else if (req.url === "/slow") {
      // Never answers; the shim's timeout has to end the request.
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function wget(
  args: string[],
  cwd = ROOT,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SHIM, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, ms: Date.now() - started }),
    );
  });
}

/** A port nothing listens on: bind one, note it, close it again. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// The two command lines found in the wild, with the URL left to the case.
const LINES: Array<[string, (url: string) => string[]]> = [
  [
    "compose up to v1.46.6",
    (url) => ["--no-verbose", "--tries=1", "--timeout=4", "--spider", url],
  ],
  [
    "compose without a timeout",
    (url) => ["--no-verbose", "--tries=1", "--spider", url],
  ],
  ["TrueNAS catalog app", (url) => ["--quiet", "--spider", url]],
];

describe.each(LINES)("the %s health check", (_name, line) => {
  it("passes on a healthy server", async () => {
    expect((await wget(line(`${base}/ok`))).code).toBe(0);
  });

  it("fails on a 503", async () => {
    expect((await wget(line(`${base}/down`))).code).toBe(1);
  });

  it("fails on a refused connection", async () => {
    const port = await closedPort();
    expect((await wget(line(`http://127.0.0.1:${port}/api/health`))).code).toBe(
      1,
    );
  });
});

describe("wget shim", () => {
  it("gives up at its timeout instead of hanging", async () => {
    const result = await wget(["-q", "-T", "1", "--spider", `${base}/slow`]);
    expect(result.code).toBe(1);
    expect(result.ms).toBeLessThan(5_000);
  });

  it("counts a redirect as an answer and does not follow it", async () => {
    expect((await wget(["-q", "--spider", `${base}/moved`])).code).toBe(0);
  });

  it("prints the body for -O - and stays quiet with -q", async () => {
    const result = await wget(["-qO-", `${base}/ok`]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"status":"ok"}');
    expect(result.stderr).toBe("");
  });

  it("accepts -O /dev/null and -S", async () => {
    const result = await wget(["-S", "-O", "/dev/null", `${base}/ok`]);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/HTTP\/1\.1 200/);
  });

  it("ignores flags it does not know", async () => {
    const result = await wget([
      "--no-check-certificate",
      "--header",
      "X-Probe: 1",
      "-c",
      "--spider",
      `${base}/ok`,
    ]);
    expect(result.code).toBe(0);
  });

  it("is not a download tool: it refuses any other output file and writes none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wget-shim-"));
    try {
      const target = join(dir, "health.json");
      const refused = await wget(["-O", target, `${base}/ok`], dir);
      expect(refused.code).toBe(2);
      expect(existsSync(target)).toBe(false);
      // Without -O real wget saves `index.html`; the shim discards the body.
      const bare = await wget([`${base}/ok`], dir);
      expect(bare.code).toBe(0);
      expect(existsSync(join(dir, "ok"))).toBe(false);
      expect(existsSync(join(dir, "index.html"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a command line without a URL", async () => {
    expect((await wget(["--spider"])).code).toBe(2);
  });

  it("is what the image installs as wget", () => {
    const dockerfile = readSource("Dockerfile", "AS runner");
    const runner = dockerfile.slice(dockerfile.search(/^FROM .* AS runner$/m));
    expect(runner).toContain(
      "COPY --from=builder /app/scripts/wget-shim.mjs /usr/local/lib/healthlog/wget-shim.mjs",
    );
    expect(runner).toContain(
      `exec node /usr/local/lib/healthlog/wget-shim.mjs "$@"\\n' > /usr/local/bin/wget`,
    );
  });
});
