import { serve } from "@hono/node-server";
import {
  APP_CSP,
  APP_STYLESHEET_PATH,
  IskraClient,
  appBasePath,
  appPage,
  appStylesheetResponse,
  isInteractionRequired,
} from "@iskra/apps";
import { Hono } from "hono";

// strict: false — обязательное условие публикации: узел проверяет кандидата
// запросом в корень приложения СО слэшем ("/{slug}/"), и роутер потом водит
// туда же зрителей. Hono по умолчанию считает "/{slug}" и "/{slug}/" разными
// путями, поэтому строгий роутер отвечает пробе 404, и версия не публикуется.
const app = new Hono({ strict: false });
const ui = new Hono();

ui.use("*", async (context, next) => {
  await next();
  context.header("Content-Security-Policy", APP_CSP);
  context.header("X-Content-Type-Options", "nosniff");
});

app.get("/healthz", (context) => context.json({ ok: true }));
ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));

// Код экрана отдаётся файлом, а не тегом <script> внутри страницы: встроенный
// блок политика содержимого отменяет, и browser-гейт публикации видит ошибку в
// консоли.
const screenScript = `
document.querySelector("#ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  const status = document.querySelector("#status");
  const message = new FormData(event.currentTarget).get("message");
  const body = JSON.stringify({ message, idempotency_key: crypto.randomUUID() });
  button.classList.add("is-busy");
  button.disabled = true;
  status.className = "status";
  status.textContent = "Искра работает над ответом…";
  try {
    const send = () => fetch("run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    let response;
    try {
      response = await send();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      response = await send();
    }
    const result = await response.json();
    document.querySelector("#result").textContent = JSON.stringify(result, null, 2);
    status.className = response.ok ? "status status--ok" : "status status--error";
    status.textContent = response.ok ? "Готово" : "Искра ответила отказом";
  } catch (error) {
    status.className = "status status--error";
    status.textContent = "Не удалось получить ответ: " + error;
  } finally {
    button.classList.remove("is-busy");
    button.disabled = false;
  }
});
`;

ui.get("/screen.js", (context) =>
  context.body(screenScript, 200, { "content-type": "text/javascript; charset=utf-8" }),
);

ui.get("/", (context) =>
  context.html(
    appPage({
      title: "Интерактивный запрос к Искре",
      request: context.req.raw,
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
    }),
  ),
);
ui.post("/run", async (context) => {
  const token = context.req.header("X-Iskra-Identity");
  const apiUrl = process.env.ISKRA_API_URL;
  if (!token || !apiUrl) return context.json({ error: "Iskra runtime identity is unavailable" }, 503);

  const raw = (await context.req.json()) as Record<string, unknown>;
  const idempotencyKey = raw?.idempotency_key;
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    return context.json({ error: "idempotency_key is required" }, 400);
  }
  const message = typeof raw.message === "string" ? raw.message : "Продолжи задачу";
  const conversationID = typeof raw.conversation_id === "string" ? raw.conversation_id : undefined;
  const inputs =
    typeof raw.inputs === "object" && raw.inputs !== null ? (raw.inputs as Record<string, unknown>) : undefined;
  const client = new IskraClient({ apiUrl, token });
  const result = await client.run(
    {
      message,
      ...(conversationID === undefined ? {} : { conversation_id: conversationID }),
      ...(inputs === undefined ? {} : { policy: { inputs } }),
    },
    { idempotencyKey },
  );
  if (isInteractionRequired(result)) {
    return context.json({
      status: result.status,
      conversation_id: result.conversation_id,
      interaction: result.interaction,
    });
  }
  return context.json(result);
});
app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
