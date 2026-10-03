import { serve } from "@hono/node-server";
import { appBasePath } from "@iskra/apps";
import { Hono } from "hono";

const app = new Hono();
const ui = new Hono();

app.get("/healthz", (context) => context.json({ ok: true }));
ui.get("/", (context) =>
  context.html(`<!doctype html>
    <html lang="ru">
      <head><meta charset="utf-8"><title>Apps Stage F 1.1.0</title></head>
      <body>
        <main>
          <h1>Apps Stage F 1.1.0</h1>
          <p id="stage-f-marker">ISKRA_APPS_STAGE_F_OK</p>
        </main>
        <script>
          (() => {
            const marker = document.querySelector("#stage-f-marker");
            const params = new URL(window.location.href).searchParams;
            const nonce = params.get("iskra_stage_f_nonce");
            const returnOrigin = params.get("iskra_stage_f_return_origin");
            if (!marker || marker.textContent.trim() !== "ISKRA_APPS_STAGE_F_OK") return;
            if (!nonce || !/^[0-9a-f]{32}$/.test(nonce) || !returnOrigin) return;
            let trustedOrigin;
            try {
              const candidate = new URL(returnOrigin);
              if (!["http:", "https:"].includes(candidate.protocol)) return;
              if (candidate.origin !== returnOrigin) return;
              trustedOrigin = candidate.origin;
            } catch {
              return;
            }
            requestAnimationFrame(() => {
              if (!marker.getClientRects().length || !window.opener) return;
              window.opener.postMessage({
                type: "iskra-apps-stage-f-result",
                value: "ISKRA_APPS_STAGE_F_OK",
                nonce,
              }, trustedOrigin);
            });
          })();
        </script>
      </body>
    </html>`),
);
app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
