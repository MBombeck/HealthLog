#!/usr/bin/env node
/**
 * Synthetic post-deploy journey.
 *
 * `post-publish-verify.yml` proves the published image boots and answers
 * `/api/version`. It does not prove that a person can sign in, write a
 * reading and read it back — and every defect the v1.38 line kept
 * rediscovering sat in exactly that gap: a value written and never read.
 * This script walks the journey against a running instance.
 *
 * Plain Node, no TypeScript and no dependencies, so it runs from a
 * workstation, from a runner, or from the deploy host with nothing
 * installed but Node 22.
 *
 * Legs, in order:
 *   0. warm    — one GET on `/`, `/api/health`, `/api/version` and the
 *                measurements list. Timings are discarded: the first hit
 *                on each route after a deploy is a cold start and says
 *                nothing about the instance's steady state.
 *   1. version — `/api/version` reports EXPECTED_VERSION.
 *   2. sign in — the password flow the web client uses (`POST
 *                /api/auth/login`, session cookie, no CSRF token), through
 *                a cookie jar.
 *   3. write   — `POST /api/measurements` with an `Idempotency-Key`.
 *   4. read    — `GET /api/measurements?type=WEIGHT&limit=1` and assert
 *                the row's id, value, unit and source.
 *   5. delete  — `DELETE /api/measurements/{id}`, then a direct `GET` on
 *                the same id that must 404, so the account stays clean and
 *                the leg proves it rather than trusting a 200.
 *
 * Legs 3 to 5 run inside a `try`/`finally`: from the write on, the run owns
 * a row on a real account, and a red read leg must not leave it behind. The
 * `finally` sweeps whatever the delete leg did not — including a row whose
 * id the write leg never learned, because the response was lost after the
 * server had committed. That row is found again by a marker the write puts
 * in `notes`, unique per run.
 *
 * `BASE_URL` decides where the probe account's password is POSTed, so it is
 * checked against a closed in-repo host allowlist and refused with exit 2
 * otherwise.
 *
 * The first failing leg ends the run with a non-zero exit, the response
 * status and a short body excerpt. Anything token-shaped in that excerpt
 * is redacted before it reaches the log.
 *
 * Usage:
 *   BASE_URL=https://review.healthlog.dev \
 *   SYNTHETIC_USERNAME=… SYNTHETIC_PASSWORD=… EXPECTED_VERSION=v1.38.13 \
 *   node scripts/synthetic-journey.mjs
 *
 *   node scripts/synthetic-journey.mjs --self-test
 *
 * `--self-test` runs the whole journey against an in-process mock: once
 * against a healthy mock, which must pass, and once per broken leg, each
 * of which must fail. A check that cannot fail is worse than no check, so
 * the script carries the proof that it can.
 *
 * The target must be a real instance, not the demo: demo mode blocks every
 * mutation, so the write leg would be red for a reason that has nothing to
 * do with the deploy. The account must not carry a second factor — the
 * password flow stops at the MFA ticket, which the script reports as a
 * configuration failure rather than a deploy failure.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const REQUEST_TIMEOUT_MS = 20_000;
/** The cold start after a deploy can take a while; the warm-up waits it out. */
const WARM_TIMEOUT_MS = 90_000;
const BODY_EXCERPT_LIMIT = 400;

/** The reading the journey writes. Distinctive, plausible, and short-lived. */
const PROBE = { type: "WEIGHT", value: 77.7, unit: "kg", source: "MANUAL" };

/**
 * The journey signs in with a real account and POSTs that account's password
 * to whatever `BASE_URL` names, so `BASE_URL` alone decides where the
 * password goes. Anyone able to name the host walks off with a working
 * credential; masking guards the log, not the egress. The allowlist is the
 * defence, and it is deliberately a const: it changes by a commit and a
 * review, never by a form field.
 */
const ALLOWED_HOSTS = [
  "review.healthlog.dev",
  "healthlog.bombeck.io",
  "localhost",
  "127.0.0.1",
];

/**
 * `null` when the host may receive the probe credentials, otherwise the line
 * the caller prints before exiting 2.
 */
function hostRefusal(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return `BASE_URL is not a URL: ${JSON.stringify(baseUrl)}`;
  }
  if (ALLOWED_HOSTS.includes(host)) return null;
  return `BASE_URL host ${JSON.stringify(host)} is not on the allowlist — the probe password is only ever sent to ${ALLOWED_HOSTS.join(", ")}`;
}

/**
 * Patterns that must never reach a log line. The first three are this
 * project's own token prefixes plus the OpenAI-style key shape the
 * idempotency cache also refuses to persist; the last two catch a raw
 * cookie value and any long opaque blob (a session id, a bearer token, an
 * MFA ticket) that a future response shape might carry.
 */
const REDACTIONS = [
  /hlk_[A-Za-z0-9_-]+/g,
  /hlr_[A-Za-z0-9_-]+/g,
  /hlh_[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /(set-cookie|cookie|authorization)\s*[:=]\s*[^\s;,"]+/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

function redact(text) {
  let out = String(text ?? "");
  for (const pattern of REDACTIONS) out = out.replace(pattern, "[redacted]");
  return out;
}

function excerpt(text) {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length > BODY_EXCERPT_LIMIT
    ? `${flat.slice(0, BODY_EXCERPT_LIMIT)}…`
    : flat;
}

/** Raised by a leg; carries the status and body the reporter prints. */
class LegFailure extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "LegFailure";
    this.status = status ?? null;
    this.body = body ?? null;
  }
}

/**
 * A cookie jar with exactly the behaviour the journey needs: remember what
 * the instance set, send it back. No domain or path matching — every
 * request goes to the one origin under test.
 */
function createCookieJar() {
  const jar = new Map();
  return {
    store(response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const index = pair.indexOf("=");
        if (index <= 0) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value === "" || value === '""') jar.delete(name);
        else jar.set(name, value);
      }
    },
    header() {
      if (jar.size === 0) return undefined;
      return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    },
  };
}

async function call(baseUrl, path, options = {}) {
  const { method = "GET", body, headers = {}, jar, timeoutMs } = options;
  const requestHeaders = { accept: "application/json", ...headers };
  const cookie = jar?.header();
  if (cookie) requestHeaders.cookie = cookie;
  if (body !== undefined) requestHeaders["content-type"] = "application/json";

  const started = performance.now();
  let response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LegFailure(`${method} ${path} did not answer: ${error.message}`);
  }
  const text = await response.text();
  jar?.store(response);

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a non-JSON body is a failure the caller reports with the excerpt */
  }
  return {
    status: response.status,
    text,
    json,
    elapsedMs: performance.now() - started,
  };
}

function expectStatus(result, expected, what) {
  if (result.status !== expected) {
    throw new LegFailure(`${what}: expected HTTP ${expected}`, {
      status: result.status,
      body: result.text,
    });
  }
}

function expectValue(actual, expected, what, result) {
  if (actual !== expected) {
    throw new LegFailure(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      { status: result?.status, body: result?.text },
    );
  }
}

/** `v1.38.13` and `1.38.13` are the same build; the tag carries the `v`. */
function normaliseVersion(value) {
  return String(value ?? "")
    .trim()
    .replace(/^v/i, "");
}

async function warm(baseUrl, jar) {
  for (const path of [
    "/",
    "/api/health",
    "/api/version",
    "/api/measurements?type=WEIGHT&limit=1",
  ]) {
    // Status and timing are both deliberately ignored. `/` redirects to the
    // login page for an anonymous caller, `/api/health` answers 503 while a
    // worker is still coming up, and the measurements list is 401 before the
    // sign-in leg. Warming is about paying the compile cost, not asserting.
    await call(baseUrl, path, { jar, timeoutMs: WARM_TIMEOUT_MS }).catch(
      () => null,
    );
  }
}

async function assertVersion(baseUrl, jar, expectedVersion) {
  const result = await call(baseUrl, "/api/version", { jar });
  expectStatus(result, 200, "version");
  const served = result.json?.data?.version;
  if (normaliseVersion(served) !== normaliseVersion(expectedVersion)) {
    throw new LegFailure(
      `version: instance serves ${JSON.stringify(served)}, expected ${JSON.stringify(expectedVersion)}`,
      { status: result.status, body: result.text },
    );
  }
  return { detail: `serves ${served}` };
}

async function signIn(baseUrl, jar, username, password) {
  const result = await call(baseUrl, "/api/auth/login", {
    method: "POST",
    jar,
    body: { email: username, password },
  });
  expectStatus(result, 200, "sign in");
  if (result.json?.meta?.mfaRequired) {
    throw new LegFailure(
      "sign in: the account asks for a second factor — the synthetic account must be password-only",
      { status: result.status },
    );
  }
  const userId = result.json?.data?.user?.id;
  if (typeof userId !== "string" || userId === "") {
    throw new LegFailure("sign in: no user in the response envelope", {
      status: result.status,
      body: result.text,
    });
  }
  if (!jar.header()) {
    throw new LegFailure("sign in: the instance set no session cookie", {
      status: result.status,
    });
  }
  return { detail: "session cookie held" };
}

async function writeReading(baseUrl, jar, run) {
  const measuredAt = new Date().toISOString();
  const result = await call(baseUrl, "/api/measurements", {
    method: "POST",
    jar,
    headers: { "idempotency-key": run.idempotencyKey },
    body: {
      type: PROBE.type,
      value: PROBE.value,
      measuredAt,
      source: PROBE.source,
      // The one handle on this row that exists before the response does.
      notes: run.marker,
    },
  });
  expectStatus(result, 201, "write");
  const created = result.json?.data;
  if (typeof created?.id !== "string" || created.id === "") {
    throw new LegFailure("write: no measurement id in the response envelope", {
      status: result.status,
      body: result.text,
    });
  }
  return { id: created.id, measuredAt, detail: `wrote ${created.id}` };
}

async function readBack(baseUrl, jar, writtenId) {
  const result = await call(
    baseUrl,
    "/api/measurements?type=WEIGHT&limit=1&sortBy=measuredAt&sortDir=desc",
    { jar },
  );
  expectStatus(result, 200, "read back");
  const rows = result.json?.data?.measurements;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new LegFailure("read back: the list came back without the reading", {
      status: result.status,
      body: result.text,
    });
  }
  const row = rows[0];
  expectValue(row.id, writtenId, "read back: id", result);
  expectValue(row.value, PROBE.value, "read back: value", result);
  expectValue(row.unit, PROBE.unit, "read back: unit", result);
  expectValue(row.source, PROBE.source, "read back: source", result);
  return { detail: `${row.value} ${row.unit} (${row.source})` };
}

async function removeReading(baseUrl, jar, writtenId) {
  const result = await call(baseUrl, `/api/measurements/${writtenId}`, {
    method: "DELETE",
    jar,
  });
  expectStatus(result, 200, "delete");
  // A 200 is the instance's claim, not the outcome. An instance that answers
  // 200 and keeps the row would have printed "account left clean" — so read
  // the id back and require the 404.
  const gone = await call(baseUrl, `/api/measurements/${writtenId}`, { jar });
  if (gone.status !== 404) {
    throw new LegFailure(
      `delete: ${writtenId} still reads back after a 200 delete`,
      { status: gone.status, body: gone.text },
    );
  }
  return { detail: "account left clean" };
}

/**
 * The id the write leg never learned. A POST that times out after the server
 * committed leaves a row this run owns and cannot name, so ask the instance
 * for it: the marker rides in `notes`, is unique per run, and comes back
 * decrypted on the list.
 */
async function findLeftover(baseUrl, jar, marker) {
  const result = await call(
    baseUrl,
    "/api/measurements?type=WEIGHT&limit=20&sortBy=measuredAt&sortDir=desc",
    { jar },
  );
  if (result.status !== 200) return null;
  const rows = result.json?.data?.measurements;
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row?.notes === marker)?.id ?? null;
}

/**
 * Best effort, never throws: a red leg is already the run's verdict, and a
 * sweep that threw would replace it. It says out loud what it could not
 * remove so the maintainer can.
 */
async function sweep(baseUrl, jar, writtenId, marker, log) {
  let id = writtenId;
  if (!id) {
    id = await findLeftover(baseUrl, jar, marker).catch(() => null);
  }
  if (!id) return;
  const result = await call(baseUrl, `/api/measurements/${id}`, {
    method: "DELETE",
    jar,
  }).catch(() => null);
  log(
    result?.status === 200
      ? `sweep     removed ${id} after a failed leg`
      : `sweep     could not remove ${id} — delete it by hand`,
  );
}

/**
 * Run the journey. Returns `{ ok: true }` or `{ ok: false, leg, error }` —
 * the caller decides what an exit code is, which is what lets the self-test
 * assert a red run without ending the process.
 */
async function runJourney(config, log = console.log) {
  const { baseUrl, username, password, expectedVersion } = config;
  const jar = createCookieJar();
  // Both known BEFORE the write, so a write whose response never arrives is
  // still recoverable: the key folds into the server's idempotency cell, the
  // marker into the row's own `notes`.
  const run = {
    idempotencyKey: randomUUID(),
    marker: `synthetic-journey ${randomUUID()}`,
  };

  const warmStarted = performance.now();
  await warm(baseUrl, jar);
  log(
    `warm      ${Math.round(performance.now() - warmStarted)} ms  (discarded)`,
  );

  const runLeg = async (name, execute) => {
    const started = performance.now();
    try {
      const outcome = await execute();
      const elapsed = Math.round(performance.now() - started);
      log(
        `ok        ${name.padEnd(10)} ${String(elapsed).padStart(6)} ms  ${outcome?.detail ?? ""}`.trimEnd(),
      );
      return { ok: true };
    } catch (error) {
      const elapsed = Math.round(performance.now() - started);
      log(
        `FAILED    ${name.padEnd(10)} ${String(elapsed).padStart(6)} ms  ${redact(error.message)}`,
      );
      if (error instanceof LegFailure) {
        if (error.status !== null) log(`          status ${error.status}`);
        if (error.body) log(`          body   ${excerpt(error.body)}`);
      } else {
        log(`          ${redact(error.stack ?? "")}`);
      }
      return { ok: false, leg: name, error };
    }
  };

  for (const [name, execute] of [
    ["version", () => assertVersion(baseUrl, jar, expectedVersion)],
    ["sign in", () => signIn(baseUrl, jar, username, password)],
  ]) {
    const result = await runLeg(name, execute);
    if (!result.ok) return result;
  }

  // From the write on, the run owns a row on somebody's real account. A red
  // read leg is not a reason to leave it there, so the cleanup sits in a
  // `finally` and not in a leg that a `return` can skip.
  let writtenId = null;
  let removed = false;
  try {
    for (const [name, execute] of [
      [
        "write",
        async () => {
          const written = await writeReading(baseUrl, jar, run);
          writtenId = written.id;
          return written;
        },
      ],
      ["read back", () => readBack(baseUrl, jar, writtenId)],
      [
        "delete",
        async () => {
          const outcome = await removeReading(baseUrl, jar, writtenId);
          removed = true;
          return outcome;
        },
      ],
    ]) {
      const result = await runLeg(name, execute);
      if (!result.ok) return result;
    }
  } finally {
    if (!removed) await sweep(baseUrl, jar, writtenId, run.marker, log);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Self-test: the journey against an in-process instance.
 * ------------------------------------------------------------------ */

const SELF_TEST_VERSION = "v9.99.0";
const SELF_TEST_CREDENTIALS = { username: "journey", password: "journey-pass" };

/**
 * A mock that answers the five legs. `breaks` names the leg to sabotage,
 * which is how the self-test proves each assertion can go red.
 */
function startMockInstance(breaks) {
  const rows = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://mock.invalid");
    const send = (status, payload, headers = {}) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify(payload));
    };
    const authenticated = (request.headers.cookie ?? "").includes(
      "hl_session=",
    );

    if (url.pathname === "/api/version") {
      const version = breaks === "version" ? "v9.98.0" : SELF_TEST_VERSION;
      return send(200, { data: { version, buildSha: null }, error: null });
    }
    if (url.pathname === "/api/health")
      return send(200, { data: {}, error: null });
    if (url.pathname === "/") return send(200, { data: null, error: null });

    if (url.pathname === "/api/auth/login") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (
          parsed.email !== SELF_TEST_CREDENTIALS.username ||
          parsed.password !== SELF_TEST_CREDENTIALS.password
        ) {
          return send(401, { data: null, error: "Invalid credentials" });
        }
        if (breaks === "sign in") {
          return send(200, {
            data: null,
            error: null,
            meta: { mfaRequired: true },
          });
        }
        send(
          200,
          {
            data: { user: { id: "user-1", username: parsed.email } },
            error: null,
          },
          { "set-cookie": "hl_session=mock-session; Path=/; HttpOnly" },
        );
      });
      return;
    }

    if (!authenticated) return send(401, { data: null, error: "Unauthorized" });

    if (url.pathname === "/api/measurements" && request.method === "POST") {
      if (breaks === "write") {
        return send(500, { data: null, error: "write failed" });
      }
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const row = {
          id: `m-${rows.size + 1}`,
          type: parsed.type,
          value: parsed.value,
          unit: PROBE.unit,
          source: parsed.source,
          measuredAt: parsed.measuredAt,
          notes: parsed.notes ?? null,
        };
        rows.set(row.id, row);
        // The case the sweep exists for: the server committed and the
        // caller never learned the id. Only the marker leads back here.
        if (breaks === "write: committed") {
          return send(500, { data: null, error: "gateway timed out" });
        }
        send(201, { data: row, error: null });
      });
      return;
    }

    if (url.pathname === "/api/measurements" && request.method === "GET") {
      let listed = [...rows.values()];
      // The mutation the plan's gate names: the read leg is broken and the
      // check has to go red.
      if (breaks === "read back: missing") listed = [];
      if (breaks === "read back: value") {
        listed = listed.map((row) => ({ ...row, value: row.value + 1 }));
      }
      if (breaks === "read back: unit") {
        listed = listed.map((row) => ({ ...row, unit: "lb" }));
      }
      if (breaks === "read back: source") {
        listed = listed.map((row) => ({ ...row, source: "IMPORT" }));
      }
      return send(200, {
        data: { measurements: listed, meta: { total: listed.length } },
        error: null,
      });
    }

    if (
      url.pathname.startsWith("/api/measurements/") &&
      request.method === "DELETE"
    ) {
      if (breaks === "delete") {
        return send(404, { data: null, error: "Measurement not found" });
      }
      // 200 and the row still there — the status alone cannot catch this,
      // only the read-back the delete leg does afterwards.
      if (breaks === "delete: kept") {
        return send(200, { data: { success: true }, error: null });
      }
      rows.delete(url.pathname.split("/").pop());
      return send(200, { data: { success: true }, error: null });
    }

    if (
      url.pathname.startsWith("/api/measurements/") &&
      request.method === "GET"
    ) {
      const row = rows.get(url.pathname.split("/").pop());
      if (!row) {
        return send(404, { data: null, error: "Measurement not found" });
      }
      return send(200, { data: row, error: null });
    }

    send(404, { data: null, error: "Not found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        rows,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * The allowlist is the only thing standing between a dispatcher and the
 * probe account's password, so prove it refuses — including the prefix
 * lookalike, which a `startsWith` check would have waved through.
 */
function selfTestHostAllowlist() {
  const cases = [
    { url: "https://review.healthlog.dev", refused: false },
    { url: "https://healthlog.bombeck.io/", refused: false },
    { url: "http://localhost:3000", refused: false },
    { url: "http://127.0.0.1:3000", refused: false },
    { url: "https://healthlog.bombeck.io.example.test", refused: true },
    { url: "https://collector.example.test", refused: true },
    { url: "not-a-url", refused: true },
  ];

  let failures = 0;
  for (const testCase of cases) {
    const refusal = hostRefusal(testCase.url);
    const label = `host ${testCase.url}`;
    if (Boolean(refusal) === testCase.refused) {
      console.log(
        `self-test ok      ${label.padEnd(44)} → ${refusal ? "refused" : "allowed"}`,
      );
    } else {
      failures += 1;
      console.log(
        `self-test FAILED  ${label.padEnd(44)} → ${refusal ? "refused" : "allowed"}, expected ${testCase.refused ? "refused" : "allowed"}`,
      );
    }
  }
  return failures;
}

/**
 * The excerpt path is what keeps a token out of a failure log. Prove it
 * once, on a body shaped like this project's own key prefix.
 */
function selfTestRedaction() {
  const shaped = `hlk_${"a".repeat(24)}`;
  const redacted = excerpt(`{"error":"bad token","token":"${shaped}"}`);
  const label = "redaction";
  if (redacted.includes("hlk_") || !redacted.includes("[redacted]")) {
    console.log(`self-test FAILED  ${label.padEnd(44)} → ${redacted}`);
    return 1;
  }
  console.log(`self-test ok      ${label.padEnd(44)} → ${redacted}`);
  return 0;
}

async function selfTest() {
  const cases = [
    { breaks: null, expect: "pass", clean: true },
    { breaks: "version", expect: "fail", leg: "version" },
    { breaks: "sign in", expect: "fail", leg: "sign in" },
    { breaks: "write", expect: "fail", leg: "write", clean: true },
    // The write committed and the response was lost: no id, and the sweep
    // has to find the row again by its marker.
    { breaks: "write: committed", expect: "fail", leg: "write", clean: true },
    // The four read cases are also the proof that a red read still deletes:
    // `clean` is asserted after the run, and only the `finally` can satisfy
    // it once the delete leg has been skipped.
    {
      breaks: "read back: missing",
      expect: "fail",
      leg: "read back",
      clean: true,
    },
    {
      breaks: "read back: value",
      expect: "fail",
      leg: "read back",
      clean: true,
    },
    {
      breaks: "read back: unit",
      expect: "fail",
      leg: "read back",
      clean: true,
    },
    {
      breaks: "read back: source",
      expect: "fail",
      leg: "read back",
      clean: true,
    },
    { breaks: "delete", expect: "fail", leg: "delete" },
    { breaks: "delete: kept", expect: "fail", leg: "delete" },
  ];

  let failures = selfTestHostAllowlist() + selfTestRedaction();
  for (const testCase of cases) {
    const label = testCase.breaks ?? "nothing broken";
    const instance = await startMockInstance(testCase.breaks);
    const lines = [];
    const outcome = await runJourney(
      {
        baseUrl: instance.baseUrl,
        username: SELF_TEST_CREDENTIALS.username,
        password: SELF_TEST_CREDENTIALS.password,
        expectedVersion: SELF_TEST_VERSION,
      },
      (line) => lines.push(line),
    );
    const leftBehind = instance.rows.size;
    await instance.close();

    const wanted = testCase.expect === "pass";
    const legMatches =
      testCase.expect === "pass" || outcome.leg === testCase.leg;
    const cleanEnough = !testCase.clean || leftBehind === 0;
    if (outcome.ok === wanted && legMatches && cleanEnough) {
      console.log(
        `self-test ok      ${label.padEnd(44)} → ${outcome.ok ? "green" : `red on "${outcome.leg}"`}${testCase.clean ? ", account clean" : ""}`,
      );
    } else {
      failures += 1;
      console.log(
        `self-test FAILED  ${label.padEnd(44)} → ${outcome.ok ? "green" : `red on "${outcome.leg}"`}${cleanEnough ? "" : `, ${leftBehind} row(s) left behind`}, expected ${testCase.expect}${testCase.leg ? ` on "${testCase.leg}"` : ""}`,
      );
      for (const line of lines) console.log(`          | ${line}`);
    }
  }

  if (failures > 0) {
    console.error(`\nself-test: ${failures} case(s) behaved wrongly`);
    return 1;
  }
  console.log(
    `\nself-test: ${cases.length} journey cases, every leg proven breakable; host allowlist and redaction proven`,
  );
  return 0;
}

/* ------------------------------------------------------------------ */

function readConfig() {
  const missing = [];
  const read = (name) => {
    const value = process.env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const config = {
    baseUrl: read("BASE_URL").replace(/\/+$/, ""),
    username: read("SYNTHETIC_USERNAME"),
    password: read("SYNTHETIC_PASSWORD"),
    expectedVersion: read("EXPECTED_VERSION"),
  };
  if (missing.length > 0) {
    console.error(`Missing environment: ${missing.join(", ")}`);
    console.error(
      "Usage: BASE_URL=… SYNTHETIC_USERNAME=… SYNTHETIC_PASSWORD=… EXPECTED_VERSION=… node scripts/synthetic-journey.mjs",
    );
    process.exit(2);
  }
  const refusal = hostRefusal(config.baseUrl);
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  return config;
}

async function main() {
  if (process.argv.includes("--self-test")) {
    process.exit(await selfTest());
  }
  const config = readConfig();
  console.log(`synthetic journey → ${config.baseUrl}`);
  const outcome = await runJourney(config);
  if (!outcome.ok) {
    console.error(`\nsynthetic journey RED on "${outcome.leg}"`);
    process.exit(1);
  }
  console.log("\nsynthetic journey green");
}

await main();
