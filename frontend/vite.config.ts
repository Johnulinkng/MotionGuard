import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules/ajv") ||
            id.includes("node_modules/fast-uri") ||
            id.includes("node_modules/json-schema")
          )
            return "contract-validation";
          if (
            id.includes("node_modules/react") ||
            id.includes("node_modules/scheduler")
          )
            return "react-runtime";
        },
      },
    },
  },
  server: {
    watch: {
      ignored: [
        "**/artifacts/**",
        "**/test-results/**",
        "**/playwright-report/**",
      ],
    },
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.MOTION_API_TARGET || "http://127.0.0.1:4011",
        changeOrigin: true,
      },
    },
  },
});
