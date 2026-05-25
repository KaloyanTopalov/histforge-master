/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Use React 17+ automatic JSX runtime in tests so component test files
  // don't need to import React manually. Matches the Next.js app config
  // (tsconfig jsx:preserve → Next handles the runtime in prod builds).
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    globals: true,
    // shadcn primitives + lucide icons add per-render module load that
    // sometimes pushes parallel-run tests past the 5s default.
    testTimeout: 15000,
    include: [
      "__tests__/**/*.test.ts",
      "__tests__/**/*.test.tsx",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
  },
});
