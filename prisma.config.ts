import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, ".env.local") });

const inContainer = fs.existsSync("/.dockerenv");
const defaultDatabaseUrl = inContainer
  ? "postgresql://healthlog:healthlog@db:5432/healthlog?schema=public"
  : "postgresql://healthlog:healthlog@localhost:5432/healthlog?schema=public";

function resolveDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim() || defaultDatabaseUrl;

  // Host-local Prisma CLI calls cannot resolve Docker-internal hostname "db".
  // Keep container behavior unchanged (Coolify / Docker runtime).
  if (inContainer) return configured;

  try {
    const parsed = new URL(configured);
    if (parsed.hostname === "db") {
      parsed.hostname = "localhost";
      return parsed.toString();
    }
    return configured;
  } catch {
    return configured;
  }
}

const databaseUrl = resolveDatabaseUrl();

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    url: databaseUrl,
  },
});
