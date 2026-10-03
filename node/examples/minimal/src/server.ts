import { serve } from "@hono/node-server";
import {
  APP_CSP,
  APP_STYLESHEET_PATH,
  appBasePath,
  appPage,
  appStylesheetResponse,
  appTitle,
} from "@iskra/apps";
import { Hono } from "hono";

// strict: false — обязательное условие публикации: узел проверяет кандидата
// запросом в корень приложения СО слэшем ("/{slug}/"), и роутер потом водит
// туда же зрителей. Hono по умолчанию считает "/{slug}" и "/{slug}/" разными
// путями, поэтому строгий роутер отвечает пробе 404, и версия не публикуется.
const app = new Hono({ strict: false });
const ui = new Hono();

// Политика содержимого нужна каждому ответу экрана, поэтому middleware стоит
// первым: зарегистрированный после маршрута, к нему Hono уже не применится.
ui.use("*", async (context, next) => {
  await next();
  context.header("Content-Security-Policy", APP_CSP);
  context.header("X-Content-Type-Options", "nosniff");
});

app.get("/healthz", (context) => context.json({ ok: true }));

// Общий стиль приложений едет внутри @iskra/apps и отдаётся своим маршрутом:
// политика содержимого встроенные <style> запрещает, а внешний источник —
// тем более.
ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));

// Название экрана приходит от роутера заголовком: владелец правит его на
// платформе, и оно доезжает до зрителей без пересборки. Запасное значение —
// имя из app.json: проба узла и локальный запуск идут мимо роутера.
ui.get("/", (context) =>
  context.html(
    appPage({
      title: appTitle(context.req.raw, "hello-iskra"),
      request: context.req.raw,
      body: `
        <section class="card card--pad">
          <p class="hint">Экран собран из общего слоя оформления: разметка обычная, классы уточняют раскладку.</p>
          <p class="actions"><button class="btn-primary" type="button">Основное действие</button><button type="button">Обычное</button></p>
        </section>`,
    }),
  ),
);

app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
