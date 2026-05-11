import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_PROXY_TARGET || "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    ...(process.env.VITE_HOST ? { host: process.env.VITE_HOST } : {}),
    proxy: {
      "/api": apiTarget
    }
  }
});
