import { APP_STYLESHEET_PATH, appStylesheetResponse } from "@iskra/apps";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { isInteractionRequired } from "@iskra/apps";
import { runAction } from "./service.js";
import { screen } from "./views.js";

export function createRoutes(): Hono {
  const ui = new Hono();
  ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));
  ui.get("/screen.js", serveStatic({ root: "./static", path: "screen.js" }));
  ui.get("/", (context) => context.html(screen(context)));
  ui.post("/run", async (context) => {
    const token = context.req.header("X-Iskra-Identity");
    const apiUrl = process.env.ISKRA_API_URL;
    if (!token || !apiUrl)
      return context.json({ error: "Iskra runtime identity is unavailable" }, 503);

    const raw = (await context.req.json()) as Record<string, unknown>;
    const idempotencyKey = raw?.idempotency_key;
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      return context.json({ error: "idempotency_key is required" }, 400);
    }
    const result = await runAction(raw, apiUrl, token, idempotencyKey);
    if (isInteractionRequired(result)) {
      return context.json({
        status: result.status,
        conversation_id: result.conversation_id,
        interaction: result.interaction,
      });
    }
    return context.json(result);
  });
  return ui;
}
