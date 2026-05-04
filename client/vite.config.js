import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = "http://localhost:5000";
/** Long scrapes (many locales × RSS) can exceed default proxy timeouts (~30s) and show "socket hang up". */
const longRunningProxy = {
  target: backend,
  changeOrigin: true,
  timeout: 600_000,
  proxyTimeout: 600_000,
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: "remind-api-server",
      configureServer(server) {
        server.httpServer?.once("listening", () => {
          console.log(
            "\n  Note: /api is proxied to http://localhost:5000. Start the API (e.g. `npm run dev` in ../server) or run both from repo root: `npm run dev`.\n",
          );
        });
      },
    },
  ],
  server: {
    proxy: {
      "/api": longRunningProxy,
      "/health": longRunningProxy,
    },
  },
})
