import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

const LOCAL_API = "http://127.0.0.1:8000";
const LOCAL_WEB = "http://localhost:5173";

export default defineConfig(({ mode }) => {
  // VITE_API_URL / VITE_WEB_URL come from .env.production(.local) or the
  // hosting provider's environment variables. Unset = local development.
  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  const apiUrl = (env.VITE_API_URL || LOCAL_API).replace(/\/+$/, "");
  const webUrl = (env.VITE_WEB_URL || LOCAL_WEB).replace(/\/+$/, "");

  return {
    plugins: [
      react(),
      viteStaticCopy({
        targets: [
          { src: "public/manifest.json", dest: "." },
          {
            // The extension's content script isn't bundled by Vite, so point it
            // at the deployed backend / website by rewriting its two constants.
            src: "public/content.js",
            dest: ".",
            transform: (content) =>
              content
                .replace(`const API_BASE   = "${LOCAL_API}";`, `const API_BASE   = "${apiUrl}";`)
                .replace(`const WEB_URL    = "${LOCAL_WEB}";`, `const WEB_URL    = "${webUrl}";`),
          },
        ],
      }),
    ],
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
