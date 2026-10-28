import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mockApi } from "./mock-api.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

// Builds the web terminal into ../public, which wrangler serves as static assets (ADR-034, ADR-036).
// `pnpm web:dev` serves synthetic fixture data from mock-api.ts; it never ships. With CORTEX_API=http://127.0.0.1:8755
// it proxies to a running local app instead (`pnpm demo`), so local-only pages such as SETTINGS can be designed live.
const backend = process.env.CORTEX_API;
export default defineConfig({
  root,
  plugins: backend ? [react()] : [react(), mockApi()],
  ...(backend ? { server: { proxy: { "/api": { target: backend, changeOrigin: true } } } } : {}),
  build: {
    outDir: fileURLToPath(new URL("../public", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
