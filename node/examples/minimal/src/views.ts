import { appPage, appTitle } from "@iskra/apps";
import type { Context } from "hono";
import { APP_NAME, APP_STYLE } from "./config.js";

export function screen(context: Context): string {
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    body: `
        <section class="card card--pad">
          <p class="hint">Экран собран из общего слоя оформления: разметка обычная, классы уточняют раскладку.</p>
          <p class="actions"><button class="btn-primary" type="button">Основное действие</button><button type="button">Обычное</button></p>
        </section>`,
  });
}
