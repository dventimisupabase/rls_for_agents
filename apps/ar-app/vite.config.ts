import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Port 3000 is the Supabase Site URL; the auth server sends consent requests to Site URL + /oauth/consent.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, strictPort: true },
  preview: { port: 3000, strictPort: true },
});
