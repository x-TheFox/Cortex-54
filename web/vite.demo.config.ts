import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// ADR-077: the public demo cockpit. Same panel, synthetic data answered in the browser (web/src/demo.ts), relative
// paths so it works from any static host or sub-path (GitHub Pages, the product website).
export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  define: { "import.meta.env.VITE_DEMO": JSON.stringify("1") },
  build: {
    outDir: fileURLToPath(new URL("../demo-dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
