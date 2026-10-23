import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mockApi } from "./mock-api.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

// Builds the web terminal into ../public, which wrangler serves as static assets (ADR-034, ADR-036).
// `pnpm web:dev` serves synthetic fixture data from mock-api.ts; it never ships.
export default defineConfig({
  root,
  plugins: [react(), mockApi()],
  build: {
    outDir: fileURLToPath(new URL("../public", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
