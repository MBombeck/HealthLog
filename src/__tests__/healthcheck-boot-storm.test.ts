/**
 * The container healthcheck cannot flap during a boot storm.
 *
 * `/api/health` gives the database two seconds to answer `SELECT 1` and says
 * 503 past that. After the start period a saturated pool (backfills, a
 * restore, a large import) can make one or two probes miss; the healthcheck
 * has to absorb that and still report an outage that lasts. The compose file
 * and the image's own HEALTHCHECK must agree, since the published image runs
 * outside compose too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = process.cwd();

function seconds(value: string): number {
  const m = /^(\d+)(ms|s|m)$/.exec(value.trim());
  if (!m) throw new Error(`unreadable duration ${value}`);
  const n = Number(m[1]);
  return m[2] === "ms" ? n / 1000 : m[2] === "m" ? n * 60 : n;
}

const probeTimeoutSeconds = (() => {
  const src = readFileSync(join(ROOT, "src/app/api/health/route.ts"), "utf8");
  const m = /DB_PROBE_TIMEOUT_MS = ([\d_]+);/.exec(src);
  if (!m) throw new Error("DB_PROBE_TIMEOUT_MS not found");
  return Number(m[1]!.replace(/_/g, "")) / 1000;
})();

interface Check {
  interval: number;
  timeout: number;
  retries: number;
  command: string;
}

function composeCheck(): Check {
  const compose = parse(
    readFileSync(join(ROOT, "docker-compose.yml"), "utf8"),
  ) as {
    services: {
      app: {
        healthcheck: {
          test: string[];
          interval: string;
          timeout: string;
          retries: number;
        };
      };
    };
  };
  const hc = compose.services.app.healthcheck;
  return {
    interval: seconds(hc.interval),
    timeout: seconds(hc.timeout),
    retries: hc.retries,
    command: hc.test.join(" "),
  };
}

function imageCheck(): Check {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const m = /HEALTHCHECK ([^\n]*\\\n[^\n]*)/.exec(dockerfile);
  if (!m) throw new Error("no HEALTHCHECK in the Dockerfile");
  const line = m[1]!;
  const flag = (name: string) => {
    const f = new RegExp(`--${name}=(\\S+)`).exec(line);
    if (!f) throw new Error(`HEALTHCHECK has no --${name}`);
    return f[1]!;
  };
  return {
    interval: seconds(flag("interval")),
    timeout: seconds(flag("timeout")),
    retries: Number(flag("retries")),
    command: line.slice(line.indexOf("CMD")),
  };
}

/**
 * The probe is Node's fetch, aborted by `AbortSignal.timeout(ms)`. The image
 * carries no curl, and its `wget` is a shim kept for health checks written
 * outside the repository (`wget-shim.test.ts`); the image's own check and the
 * bundled compose file do not lean on it, so neither names one.
 */
function probeTimeout(command: string): number {
  expect(command, "the image's own probe is the Node fetch").not.toMatch(
    /\b(wget|curl)\b/,
  );
  const m =
    /fetch\('http:\/\/127\.0\.0\.1:3000\/api\/health',\{signal:AbortSignal\.timeout\((\d+)\)\}\)/.exec(
      command,
    );
  if (!m) throw new Error(`no aborting /api/health fetch in: ${command}`);
  return Number(m[1]) / 1000;
}

describe.each([
  ["docker-compose.yml", composeCheck],
  ["Dockerfile", imageCheck],
])("%s healthcheck", (_name, read) => {
  it("rides out two minutes of slow probes before calling the app unhealthy", () => {
    const check = read();
    expect(check.interval * check.retries).toBeGreaterThanOrEqual(120);
  });

  it("ends the request inside Docker's timeout, after the database probe's", () => {
    const check = read();
    const abort = probeTimeout(check.command);
    expect(abort).toBeGreaterThan(probeTimeoutSeconds);
    expect(abort).toBeLessThan(check.timeout);
  });
});

it("compose and the image agree", () => {
  const a = composeCheck();
  const b = imageCheck();
  expect([a.interval, a.timeout, a.retries]).toEqual([
    b.interval,
    b.timeout,
    b.retries,
  ]);
});
