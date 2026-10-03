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

// Макет «Список и карточка»: поставщики слева, карточка выбранного справа.
// Параметры заготовки: `iskra-app init --layout master-detail --style <id>`
// подменяет ровно эти две строки. APP_NAME — запасное название экрана, пока
// запрос идёт мимо роутера (проба узла, локальный запуск).
const APP_NAME = "layout-master-detail";
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

interface Supplier {
  readonly id: string;
  readonly name: string;
  readonly inn: string;
  readonly city: string;
  readonly contact: string;
  readonly phone: string;
  readonly invoices: readonly { number: string; date: string; amount: number }[];
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
const suppliers: readonly Supplier[] = [
  {
    id: "sever",
    name: "ООО «Северный склад»",
    inn: "7810123456",
    city: "Санкт-Петербург",
    contact: "Андрей Смирнов",
    phone: "+7 812 555-01-20",
    invoices: [
      { number: "ТН-2026-0418", date: "2026-09-26", amount: 184_300 },
      { number: "ТН-2026-0396", date: "2026-09-08", amount: 64_720.5 },
    ],
  },
  {
    id: "technosnab",
    name: "АО «ТехноСнаб»",
    inn: "7705987654",
    city: "Москва",
    contact: "Елена Орлова",
    phone: "+7 495 555-17-44",
    invoices: [
      { number: "ТН-2026-0417", date: "2026-09-25", amount: 49_656.24 },
      { number: "ТН-2026-0401", date: "2026-09-12", amount: 230_000 },
    ],
  },
  {
    id: "kravtsova",
    name: "ИП Кравцова Н. А.",
    inn: "166012345678",
    city: "Казань",
    contact: "Наталья Кравцова",
    phone: "+7 843 555-66-10",
    invoices: [{ number: "ТН-2026-0412", date: "2026-09-22", amount: 12_800 }],
  },
  {
    id: "promtara",
    name: "ООО «Промтара»",
    inn: "5402765432",
    city: "Новосибирск",
    contact: "Игорь Белов",
    phone: "+7 383 555-32-08",
    invoices: [],
  },
];

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const date = (iso: string): string => iso.split("-").reverse().join(".");

function detail(supplier: Supplier): string {
  const invoices = supplier.invoices.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Накладная</th><th>Дата</th><th class="num">Сумма</th></tr></thead>
        <tbody>${supplier.invoices
          .map(
            (invoice) =>
              `<tr><td>${escapeHTML(invoice.number)}</td><td>${date(invoice.date)}</td><td class="num">${money.format(invoice.amount)}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>`
    : '<p class="empty">Накладных от поставщика ещё не было.</p>';
  return `
    <section class="card card--pad stack">
      <h2>${escapeHTML(supplier.name)}</h2>
      <table class="pairs">
        <tbody>
          <tr><th>ИНН</th><td>${escapeHTML(supplier.inn)}</td></tr>
          <tr><th>Город</th><td>${escapeHTML(supplier.city)}</td></tr>
          <tr><th>Контакт</th><td>${escapeHTML(supplier.contact)}</td></tr>
          <tr><th>Телефон</th><td>${escapeHTML(supplier.phone)}</td></tr>
        </tbody>
      </table>
      <h3 class="section__title">Накладные</h3>
      ${invoices}
    </section>`;
}

ui.get("/", (context) => {
  // Выбор живёт в адресе (?id=): ссылку на карточку можно переслать, а кнопка
  // «Назад» браузера возвращает к прежнему поставщику.
  const requested = context.req.query("id");
  const selected =
    requested === undefined ? suppliers[0] : suppliers.find((item) => item.id === requested);
  const list = suppliers
    .map(
      (supplier) =>
        `<a class="list-select__item" href="./?id=${encodeURIComponent(supplier.id)}"${supplier === selected ? ' aria-current="true"' : ""}>${escapeHTML(supplier.name)}</a>`,
    )
    .join("");
  const card = selected
    ? detail(selected)
    : '<section class="card card--pad"><p class="empty">Поставщик не найден. Выберите его в списке.</p></section>';
  return context.html(
    appPage({
      title: appTitle(context.req.raw, APP_NAME),
      request: context.req.raw,
      style: APP_STYLE,
      body: `
        <div class="split">
          <nav class="list-select" aria-label="Поставщики">${list}</nav>
          ${card}
        </div>`,
    }),
    selected ? 200 : 404,
  );
});

app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
