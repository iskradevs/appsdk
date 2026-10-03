import { serve } from "@hono/node-server";
import { APP_CSP, appBasePath } from "@iskra/apps";
import { Hono } from "hono";
import { createRoutes } from "./routes.js";

// Проба публикации и зрители обращаются к корню с завершающим слэшем.
const app = new Hono({ strict: false });
app.use("*", async (context, next) => {
  await next();
  context.header("Content-Security-Policy", APP_CSP);
  context.header("X-Content-Type-Options", "nosniff");
});
app.get("/healthz", (context) => context.json({ ok: true }));
app.route(appBasePath(), createRoutes());
serve({ fetch: app.fetch, port: 8080 });
