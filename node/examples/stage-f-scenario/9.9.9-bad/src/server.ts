import { serve } from "@hono/node-server";
import { appBasePath } from "@iskra/apps";
import { Hono } from "hono";

const app = new Hono();
const ui = new Hono();

app.get("/healthz", (context) => context.json({ ok: false, fixture: "probe_error" }, 503));
ui.get("/", (context) =>
  context.html("<main><h1>Apps Stage F deliberate probe failure</h1></main>"),
);
app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
