import { serve } from "@hono/node-server";
import {
  APP_CSP,
  APP_STYLESHEET_PATH,
  type AppStyle,
  appBasePath,
  appPage,
  appStylesheetResponse,
  appTitle,
  escapeHTML,
} from "@iskra/apps";
import { type Context, Hono } from "hono";

// Макет «Форма»: заявка поставщику и карточка принятой заявки.
// Параметры заготовки: `iskra-app init --layout form --style <id>` подменяет
// ровно эти две строки. APP_NAME — запасное название экрана, пока запрос идёт
// мимо роутера (проба узла, локальный запуск).
const APP_NAME = "layout-form";
const APP_STYLE: AppStyle = "iskra";

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
ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));

interface SupplyRequest {
  readonly id: number;
  readonly supplier: string;
  readonly item: string;
  readonly quantity: number;
  readonly deadline: string;
  readonly comment: string;
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
// Для настоящих заявок — SQLite через appDataPath (см. examples/stateful).
// Память конечна, поэтому хранятся только последние MAX_REQUESTS заявок.
const MAX_REQUESTS = 100;
const requests: SupplyRequest[] = [
  {
    id: 1041,
    supplier: "ООО «Северный склад»",
    item: "Бумага офисная А4, коробка",
    quantity: 40,
    deadline: "2026-10-06",
    comment: "Доставка на склад № 2",
  },
];
let nextId = 1042;

const suppliers = ["ООО «Северный склад»", "АО «ТехноСнаб»", "ИП Кравцова Н. А.", "ООО «Промтара»"];

// Пределы длины полей: одни и те же числа уходят в maxlength разметки и в
// проверку на сервере — браузерный maxlength обходится любым запросом мимо формы.
const LIMITS = { item: 200, quantity: 6, deadline: 10, comment: 500 } as const;

interface FormValues {
  readonly supplier: string;
  readonly item: string;
  readonly quantity: string;
  readonly deadline: string;
  readonly comment: string;
}

const FIELD_LABELS: Record<keyof typeof LIMITS, string> = {
  item: "Позиция",
  quantity: "Количество",
  deadline: "Срок поставки",
  comment: "Комментарий",
};

const emptyValues: FormValues = { supplier: "", item: "", quantity: "", deadline: "", comment: "" };

// Всё, что ввёл зритель, попадает в разметку только через escapeHTML — и в
// текст, и в атрибут value.
function requestForm(values: FormValues, error?: string): string {
  const options = suppliers
    .map(
      (name) =>
        `<option${name === values.supplier ? " selected" : ""}>${escapeHTML(name)}</option>`,
    )
    .join("");
  return `
    <section class="card card--pad">
      <form class="stack" method="post" action="./">
        <h2 class="section__title">Новая заявка</h2>
        <div class="fields-grid">
          <label class="field">
            <span class="field__label">Поставщик</span>
            <select name="supplier" required><option value="">Выберите поставщика</option>${options}</select>
          </label>
          <label class="field">
            <span class="field__label">Срок поставки</span>
            <input type="date" name="deadline" value="${escapeHTML(values.deadline)}" required />
          </label>
          <label class="field">
            <span class="field__label">Позиция</span>
            <input name="item" value="${escapeHTML(values.item)}" maxlength="${LIMITS.item}" required />
          </label>
          <label class="field">
            <span class="field__label">Количество</span>
            <input type="number" name="quantity" min="1" max="999999" value="${escapeHTML(values.quantity)}" required />
          </label>
          <label class="field field--wide">
            <span class="field__label">Комментарий</span>
            <textarea name="comment" rows="3" maxlength="${LIMITS.comment}">${escapeHTML(values.comment)}</textarea>
          </label>
        </div>
        ${error ? `<p class="status status--error" role="alert">${escapeHTML(error)}</p>` : ""}
        <p class="actions"><button class="btn-primary" type="submit">Отправить заявку</button></p>
      </form>
    </section>`;
}

function resultCard(request: SupplyRequest): string {
  return `
    <section class="card card--pad stack">
      <p class="status status--ok">Заявка № ${request.id} принята</p>
      <table class="pairs">
        <tbody>
          <tr><th>Поставщик</th><td>${escapeHTML(request.supplier)}</td></tr>
          <tr><th>Позиция</th><td>${escapeHTML(request.item)}</td></tr>
          <tr><th>Количество</th><td>${request.quantity}</td></tr>
          <tr><th>Срок</th><td>${escapeHTML(request.deadline)}</td></tr>
          <tr><th>Комментарий</th><td>${escapeHTML(request.comment || "—")}</td></tr>
        </tbody>
      </table>
    </section>`;
}

function screen(context: Context, body: string): string {
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    body: `<div class="stack">${body}</div>`,
  });
}

ui.get("/", (context) => {
  const created = requests.find((item) => String(item.id) === context.req.query("created"));
  return context.html(
    screen(context, `${created ? resultCard(created) : ""}${requestForm(emptyValues)}`),
  );
});

// POST → redirect (303): обновление страницы после отправки не создаёт вторую
// заявку. Адрес перехода относительный — приложение живёт под /{slug}/.
ui.post("/", async (context) => {
  const form = await context.req.parseBody();
  const text = (name: keyof FormValues): string => {
    const value = form[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const values: FormValues = {
    supplier: text("supplier"),
    item: text("item"),
    quantity: text("quantity"),
    deadline: text("deadline"),
    comment: text("comment"),
  };
  const quantity = Number(values.quantity);
  const tooLong = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).find(
    (name) => values[name].length > LIMITS[name],
  );
  const error = tooLong
    ? `Поле «${FIELD_LABELS[tooLong]}» длиннее ${LIMITS[tooLong]} символов.`
    : !suppliers.includes(values.supplier)
      ? "Выберите поставщика из списка."
      : !values.item
        ? "Укажите позицию."
        : !Number.isInteger(quantity) || quantity < 1
          ? "Количество — целое число больше нуля."
          : !/^\d{4}-\d{2}-\d{2}$/.test(values.deadline)
            ? "Укажите срок поставки."
            : undefined;
  if (error) return context.html(screen(context, requestForm(values, error)), 422);
  const id = nextId++;
  requests.push({ id, ...values, quantity });
  if (requests.length > MAX_REQUESTS) requests.splice(0, requests.length - MAX_REQUESTS);
  return context.redirect(`./?created=${id}`, 303);
});

app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
