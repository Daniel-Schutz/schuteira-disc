import { defineConfig, loadEnv } from "vite";
import { mintToken } from "./server/mintToken.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    server: {
      port: 5173,
      host: true,
    },
    plugins: [
      {
        name: "livekit-token",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const host = req.headers.host ?? "localhost";
            const url = new URL(req.url ?? "/", `http://${host}`);
            if (url.pathname !== "/api/token") {
              next();
              return;
            }
            if (req.method !== "GET") {
              res.statusCode = 405;
              res.end();
              return;
            }

            const apiKey = env.LIVEKIT_API_KEY;
            const apiSecret = env.LIVEKIT_API_SECRET;
            if (!apiKey || !apiSecret) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "LiveKit não configurado" }));
              return;
            }

            try {
              const token = await mintToken({
                apiKey,
                apiSecret,
                name: url.searchParams.get("name") ?? "Visitante",
              });
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ token }));
            } catch {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Não deu para criar o token" }));
            }
          });
        },
      },
    ],
  };
});
