import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.VITE_HOST || undefined,
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000"
    }
  }
});
