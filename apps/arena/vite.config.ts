import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The arena runs beside the AR app (:3000) against the same local stack. The dev agent allows both origins;
// see REPORT_04 "Arena: decisions and plan" for which app the local Site URL points at.
export default defineConfig({
  plugins: [react()],
  server: { port: 3001, strictPort: true },
  preview: { port: 3001, strictPort: true },
});
