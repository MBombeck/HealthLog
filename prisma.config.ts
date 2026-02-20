import path from "node:path";
import { defineConfig } from "prisma/config";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://healthlog:healthlog@db:5432/healthlog?schema=public";

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    url: databaseUrl,
  },
});
