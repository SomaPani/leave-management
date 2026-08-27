import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma's generated client — machine-written TypeScript, not source.
    "generated/**",
    // Vendored export of the Claude Design project this app was built from.
    // Reference material, not source — lint it and you only lint their runtime.
    "design/**",
  ]),
]);

export default eslintConfig;
