import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), {
    name: "preview-compression-and-cache",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        res.setHeader("Cache-Control", path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache");
        next();
      });
    },
  }],
  server: { proxy: { "/api": "http://localhost:3001" } },
  test: {
    environment: "node",
    coverage: { provider: "v8", reporter: ["text", "json-summary"] },
  },
});
