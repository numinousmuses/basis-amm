import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** @meteorwallet/sdk imports `utils` from near-api-js v6, which v7 (used by the SDK) removed.
 * Resolve near-api-js to the v6 copy for that package only; everything else keeps v7. */
function meteorNearApiV6(): Plugin {
  const require = createRequire(import.meta.url);
  const v6 = dirname(require.resolve("near-api-js-v6/package.json"));
  return {
    name: "meteor-near-api-js-v6",
    enforce: "pre",
    async resolveId(id, importer, opts) {
      if (id === "near-api-js" && importer && importer.includes("@meteorwallet")) {
        return this.resolve(v6, importer, { ...opts, skipSelf: true });
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [meteorNearApiV6(), react()],
  resolve: { alias: { buffer: "buffer/" } },
  build: { target: "es2022", chunkSizeWarningLimit: 3000 },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
} as any);
