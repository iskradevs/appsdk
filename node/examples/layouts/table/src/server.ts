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

// Макет «Таблица»: реестр накладных с поиском.
// Параметры заготовки: `iskra-app init --layout table --style <id>` подменяет
// ровно эти две строки. APP_NAME — запасное название экрана, пока запрос идёт
// мимо роутера (проба узла, локальный запуск).
const APP_NAME = "layout-table";
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

type InvoiceStatus = "new" | "review" | "paid" | "overdue";

interface Invoice {
  readonly number: string;
  readonly date: string;
  readonly supplier: string;
  readonly amount: number;
  readonly status: InvoiceStatus;
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
const invoices: readonly Invoice[] = [
  {
    number: "ТН-2026-0418",
    date: "2026-09-26",
    supplier: "ООО «Северный склад»",
    amount: 184_300,
    status: "new",
  },
  {
    number: "ТН-2026-0417",
    date: "2026-09-25",
    supplier: "АО «ТехноСнаб»",
    amount: 49_656.24,
    status: "review",
  },
  {
    number: "ТН-2026-0412",
    date: "2026-09-22",
    supplier: "ИП Кравцова Н. А.",
    amount: 12_800,
    status: "paid",
  },
  {
    number: "ТН-2026-0409",
    date: "2026-09-19",
    supplier: "ООО «Промтара»",
    amount: 97_150,
    status: "paid",
  },
  {
    number: "ТН-2026-0401",
    date: "2026-09-12",
    supplier: "АО «ТехноСнаб»",
    amount: 230_000,
    status: "overdue",
  },
  {
    number: "ТН-2026-0396",
    date: "2026-09-08",
    supplier: "ООО «Северный склад»",
    amount: 64_720.5,
    status: "paid",
  },
  {
    number: "ТН-2026-0388",
    date: "2026-09-02",
    supplier: "ООО «Промтара»",
    amount: 18_400,
    status: "overdue",
  },
];

const statusBadge: Record<InvoiceStatus, string> = {
  new: '<span class="badge badge--accent">Новая</span>',
  review: '<span class="badge">На проверке</span>',
  paid: '<span class="badge badge--success">Оплачена</span>',
  overdue: '<span class="badge badge--danger">Просрочена</span>',
};

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const date = (iso: string): string => iso.split("-").reverse().join(".");

ui.get("/", (context) => {
  const query = (context.req.query("q") ?? "").trim();
  const needle = query.toLocaleLowerCase("ru");
  const rows = invoices.filter(
    (invoice) =>
      !needle ||
      invoice.number.toLocaleLowerCase("ru").includes(needle) ||
      invoice.supplier.toLocaleLowerCase("ru").includes(needle),
  );
  // Строка поиска — ввод зрителя: в value и в текст идёт через escapeHTML.
  const table = rows.length
    ? `<table>
        <thead><tr><th>Номер</th><th>Дата</th><th>Поставщик</th><th class="num">Сумма</th><th>Статус</th></tr></thead>
        <tbody>${rows
          .map(
            (invoice) => `<tr>
              <td>${escapeHTML(invoice.number)}</td>
              <td>${date(invoice.date)}</td>
              <td>${escapeHTML(invoice.supplier)}</td>
              <td class="num">${money.format(invoice.amount)}</td>
              <td>${statusBadge[invoice.status]}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>`
    : `<p class="empty">По запросу «${escapeHTML(query)}» накладных нет.</p>`;
  return context.html(
    appPage({
      title: appTitle(context.req.raw, APP_NAME),
      request: context.req.raw,
      style: APP_STYLE,
      wide: true,
      body: `
        <div class="stack">
          <form class="toolbar" method="get" action="./" role="search">
            <input type="search" name="q" value="${escapeHTML(query)}" placeholder="Номер или поставщик" aria-label="Поиск накладных" />
            <span class="actions"><button type="submit">Найти</button></span>
            <p class="status">Найдено: ${rows.length} из ${invoices.length}</p>
          </form>
          <section class="card table-wrap">${table}</section>
        </div>`,
    }),
  );
});

app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
