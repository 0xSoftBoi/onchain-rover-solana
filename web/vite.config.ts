import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Buffer/process shims are needed by @solana/web3.js in the browser.
export default defineConfig({
  plugins: [react()],
  define: { "process.env": {}, global: "globalThis" },
  resolve: { alias: { buffer: "buffer" } },
  server: { port: 5173 },
});
