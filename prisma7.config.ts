import "dotenv/config";
import { defineConfig } from "prisma/config";

import { prismaDatabaseUrl } from "./lib/prisma-url";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: prismaDatabaseUrl(),
  },
});
