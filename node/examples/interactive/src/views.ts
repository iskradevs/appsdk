import { appPage, appTitle } from "@iskra/apps";
import type { Context } from "hono";
import { APP_NAME, APP_STYLE } from "./config.js";

export function screen(context: Context): string {
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    head: '<script src="screen.js" defer></script>',
    body: `
        <section class="card card--pad">
          <form id="ask" class="stack">
            <label class="field">
              <span class="field__label">Задача для Искры</span>
              <input name="message" value="Подготовь план поездки" />
            </label>
            <p class="actions">
              <button class="btn-primary"><span class="spinner" aria-hidden="true"></span>Запустить</button>
            </p>
          </form>
          <p id="status" class="status" role="status"></p>
        </section>
        <section class="card card--pad">
          <pre id="result"></pre>
        </section>`,
  });
}
