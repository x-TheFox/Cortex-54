import { defineConfig } from "vitest/config";

// Phase 0: pure-logic tests run in Node. The Workers pool (@cloudflare/vitest-pool-workers) is added in
// Phase 1 for DO/D1 integration tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
