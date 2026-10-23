import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const studioDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: resolve(studioDirectory, "../assets"),
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    fs: { allow: [resolve(studioDirectory, "..")] },
    proxy: {
      "/api": "http://127.0.0.1:4174",
    },
    headers: {
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // `bun run serve` serves repo assets/ directly (after dist/); copying them would
    // leave stale duplicates (e.g. catalog.json) that shadow the live files.
    copyPublicDir: false,
  },
});
