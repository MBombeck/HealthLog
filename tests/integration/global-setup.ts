/**
 * Vitest globalSetup — boots ONE Postgres testcontainer for the whole
 * integration run, applies migrations, and exposes the connection URL
 * via process.env.DATABASE_URL. The teardown returned at the end stops
 * the container after all test files have finished.
 *
 * Why globalSetup instead of beforeAll/afterAll per file:
 *   - The application's Prisma singleton in `src/lib/db.ts` is built at
 *     module load time using the current `process.env.DATABASE_URL`. If
 *     the container is rotated between test files, the singleton keeps
 *     pointing at the dead container and queries fail. Booting once,
 *     keeping the URL stable, and truncating between tests is both
 *     faster and safer.
 *   - Truncate-between-tests still gives per-test isolation; see
 *     `setup.ts -> truncateAllTables`.
 */
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");

let container: StartedPostgreSqlContainer | null = null;

export default async function setup(): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("healthlog_test")
    .withUsername("healthlog")
    .withPassword("healthlog")
    .start();

  const url = container.getConnectionUri() + "?schema=public&pgbouncer=false";
  process.env.DATABASE_URL = url;

  // Provided so child processes (e.g. Prisma's CLI) inherit the URL.
  // Vitest also forwards process.env to test workers, so the
  // application Prisma singleton sees this URL when it loads.
  execSync("pnpm db:migrate:deploy", {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });

  return async () => {
    if (container) {
      await container.stop({ remove: true });
      container = null;
    }
  };
}
