import { serve } from "@hono/node-server";
import {
  APP_CSP,
  APP_STYLESHEET_PATH,
  type AppPageLink,
  type AppStyle,
  appBasePath,
  appPage,
  appStylesheetResponse,
  appTitle,
  escapeHTML,
} from "@iskra/apps";
import { Hono } from "hono";

// Макет «Меню слева»: три раздела, у каждого свой экран.
// Параметры заготовки: `iskra-app init --layout sidebar --style <id>` подменяет
// ровно эти две строки. APP_NAME — запасное название экрана, пока запрос идёт
// мимо роутера (проба узла, локальный запуск).
const APP_NAME = "layout-sidebar";
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

interface Invoice {
  readonly number: string;
  readonly date: string;
  readonly supplier: string;
  readonly amount: number;
  readonly paid: boolean;
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
const invoices: readonly Invoice[] = [
  {
    number: "ТН-2026-0418",
    date: "2026-09-26",
    supplier: "ООО «Северный склад»",
    amount: 184_300,
    paid: false,
  },
  {
    number: "ТН-2026-0417",
    date: "2026-09-25",
    supplier: "АО «ТехноСнаб»",
    amount: 49_656.24,
    paid: false,
  },
  {
    number: "ТН-2026-0412",
    date: "2026-09-22",
    supplier: "ИП Кравцова Н. А.",
    amount: 12_800,
    paid: true,
  },
  {
    number: "ТН-2026-0409",
    date: "2026-09-19",
    supplier: "ООО «Промтара»",
    amount: 97_150,
    paid: true,
  },
  {
    number: "ТН-2026-0401",
    date: "2026-09-12",
    supplier: "АО «ТехноСнаб»",
    amount: 230_000,
    paid: false,
  },
];

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const date = (iso: string): string => iso.split("-").reverse().join(".");

function invoicesSection(): string {
  const rows = invoices
    .map(
      (invoice) => `<tr>
        <td>${escapeHTML(invoice.number)}</td>
        <td>${date(invoice.date)}</td>
        <td>${escapeHTML(invoice.supplier)}</td>
        <td class="num">${money.format(invoice.amount)}</td>
        <td>${invoice.paid ? '<span class="badge badge--success">Оплачена</span>' : '<span class="badge">К оплате</span>'}</td>
      </tr>`,
    )
    .join("");
  return `<section class="card table-wrap"><table>
    <thead><tr><th>Номер</th><th>Дата</th><th>Поставщик</th><th class="num">Сумма</th><th>Статус</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></section>`;
}

function suppliersSection(): string {
  const bySupplier = new Map<string, number>();
  for (const invoice of invoices)
    bySupplier.set(invoice.supplier, (bySupplier.get(invoice.supplier) ?? 0) + 1);
  const rows = [...bySupplier]
    .map(
      ([supplier, count]) =>
        `<tr><td>${escapeHTML(supplier)}</td><td class="num">${count}</td></tr>`,
    )
    .join("");
  return `<section class="card table-wrap"><table>
    <thead><tr><th>Поставщик</th><th class="num">Накладных</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></section>`;
}

function reportsSection(): string {
  const total = (paid: boolean): number =>
    invoices
      .filter((invoice) => invoice.paid === paid)
      .reduce((sum, invoice) => sum + invoice.amount, 0);
  return `<section class="card card--pad stack">
    <h2 class="section__title">Сентябрь 2026</h2>
    <table class="pairs">
      <tbody>
        <tr><th>Оплачено</th><td class="num">${money.format(total(true))}</td></tr>
        <tr><th>К оплате</th><td class="num">${money.format(total(false))}</td></tr>
        <tr><th>Всего накладных</th><td class="num">${invoices.length}</td></tr>
      </tbody>
    </table>
  </section>`;
}

// Разделы меню. Раздел — query-параметр на одном уровне с корнем, а не
// вложенный путь: приложение живёт под /{slug}/, и на адресе вроде
// /{slug}/suppliers/ относительные ссылки и iskra.css уехали бы на уровень
// глубже. Главный раздел — просто "./".
const sections = [
  { key: "", href: "./", label: "Накладные", render: invoicesSection },
  { key: "suppliers", href: "./?section=suppliers", label: "Поставщики", render: suppliersSection },
  { key: "reports", href: "./?section=reports", label: "Отчёты", render: reportsSection },
] as const;

ui.get("/", (context) => {
  const key = context.req.query("section") ?? "";
  const current = sections.find((section) => section.key === key);
  const nav: AppPageLink[] = sections.map((section) => ({
    href: section.href,
    label: section.label,
    current: section === current,
  }));
  return context.html(
    appPage({
      title: appTitle(context.req.raw, APP_NAME),
      request: context.req.raw,
      style: APP_STYLE,
      nav,
      navPosition: "side",
      body: current
        ? current.render()
        : '<section class="card card--pad"><p class="empty">Такого раздела нет. Выберите раздел в меню.</p></section>',
    }),
    current ? 200 : 404,
  );
});

app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
