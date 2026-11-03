import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { pricesPlugin } from "./scripts/prices.ts";

// The Worker's configuration lives in cloudflare.config.ts.
// PI_OFFLINE=1 runs without a Cloudflare account: no remote bindings, so the
// model (AI binding) is unavailable but everything else, MCP included, works.
// A build reads the vendors' prices into worker/prices.json once the file is a week old, and fails if it cannot.
export default defineConfig({
  plugins: [pricesPlugin(), react(), cloudflare({ remoteBindings: process.env.PI_OFFLINE !== "1" })],
});
