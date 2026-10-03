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
import { Hono } from "hono";

// Макет «Дашборд»: плитки ключевых цифр и последние операции.
// Параметры заготовки: `iskra-app init --layout dashboard --style <id>`
// подменяет ровно эти две строки. APP_NAME — запасное название экрана, пока
// запрос идёт мимо роутера (проба узла, локальный запуск).
const APP_NAME = "layout-dashboard";
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

interface Operation {
  readonly date: string;
  readonly kind: "Получена накладная" | "Оплата" | "Возврат";
  readonly supplier: string;
  readonly amount: number;
  readonly overdue?: boolean;
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
// Плитки считаются из тех же операций, что и таблица, — цифры не расходятся.
const operations: readonly Operation[] = [
  {
    date: "2026-09-26",
    kind: "Получена накладная",
    supplier: "ООО «Северный склад»",
    amount: 184_300,
  },
  { date: "2026-09-25", kind: "Получена накладная", supplier: "АО «ТехноСнаб»", amount: 49_656.24 },
  { date: "2026-09-24", kind: "Оплата", supplier: "ИП Кравцова Н. А.", amount: 12_800 },
  { date: "2026-09-22", kind: "Оплата", supplier: "ООО «Промтара»", amount: 97_150 },
  { date: "2026-09-18", kind: "Возврат", supplier: "ООО «Промтара»", amount: 4_300 },
  {
    date: "2026-09-12",
    kind: "Получена накладная",
    supplier: "АО «ТехноСнаб»",
    amount: 230_000,
    overdue: true,
  },
];

const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});
const exactMoney = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const date = (iso: string): string => iso.split("-").reverse().join(".");

function kpi(label: string, value: string): string {
  return `<div class="kpi"><span class="kpi__label">${escapeHTML(label)}</span><span class="kpi__value">${escapeHTML(value)}</span></div>`;
}

ui.get("/", (context) => {
  const received = operations.filter((operation) => operation.kind === "Получена накладная");
  const paid = operations.filter((operation) => operation.kind === "Оплата");
  const overdue = received.filter((operation) => operation.overdue);
  const sum = (list: readonly Operation[]): number =>
    list.reduce((total, item) => total + item.amount, 0);
  const rows = operations
    .map(
      (operation) => `<tr>
        <td>${date(operation.date)}</td>
        <td>${escapeHTML(operation.kind)}${operation.overdue ? ' <span class="badge badge--danger">Просрочена</span>' : ""}</td>
        <td>${escapeHTML(operation.supplier)}</td>
        <td class="num">${exactMoney.format(operation.amount)}</td>
      </tr>`,
    )
    .join("");
  return context.html(
    appPage({
      title: appTitle(context.req.raw, APP_NAME),
      request: context.req.raw,
      style: APP_STYLE,
      body: `
        <div class="stack">
          <section class="kpis" aria-label="Сентябрь 2026">
            ${kpi("Накладных за месяц", String(received.length))}
            ${kpi("Оплачено", money.format(sum(paid)))}
            ${kpi("Просрочено к оплате", money.format(sum(overdue)))}
          </section>
          <h2 class="section__title">Последние операции</h2>
          <section class="card table-wrap">
            <table>
              <thead><tr><th>Дата</th><th>Операция</th><th>Поставщик</th><th class="num">Сумма</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </section>
        </div>`,
    }),
  );
});

app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
