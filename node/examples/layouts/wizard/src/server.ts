import { randomUUID } from "node:crypto";

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

// Макет «Мастер»: регистрация накладной в три шага.
// Параметры заготовки: `iskra-app init --layout wizard --style <id>` подменяет
// ровно эти две строки. APP_NAME — запасное название экрана, пока запрос идёт
// мимо роутера (проба узла, локальный запуск).
const APP_NAME = "layout-wizard";
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

interface Draft {
  supplier: string;
  number: string;
  amount: string;
  dueDate: string;
}

const STEPS = ["Поставщик", "Сумма и срок", "Проверка"] as const;
const suppliers = ["ООО «Северный склад»", "АО «ТехноСнаб»", "ИП Кравцова Н. А.", "ООО «Промтара»"];

// Черновики и накладные живут в памяти процесса: пример показывает экран, а не
// хранение. Память конечна: черновиков не больше MAX_DRAFTS (брошенные
// вытесняются старейшими), накладных — последние MAX_REGISTERED.
const MAX_DRAFTS = 200;
const MAX_REGISTERED = 100;
const drafts = new Map<string, Draft>();
const registered: {
  id: number;
  number: string;
  supplier: string;
  amount: number;
  dueDate: string;
}[] = [];
let nextId = 1;

// Пределы длины полей: одни и те же числа уходят в maxlength разметки и в
// проверку на сервере — браузерный maxlength обходится любым запросом мимо формы.
const LIMITS = { number: 40, amount: 15, dueDate: 10 } as const;
const FIELD_LABELS: Record<keyof typeof LIMITS, string> = {
  number: "Номер накладной",
  amount: "Сумма",
  dueDate: "Оплатить до",
};

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });

function stepOf(raw: string | undefined): 1 | 2 | 3 {
  return raw === "2" ? 2 : raw === "3" ? 3 : 1;
}

function stepsBar(current: number): string {
  const items = STEPS.map((label, index) => {
    const step = index + 1;
    const state = step < current ? " step--done" : step === current ? " step--current" : "";
    return `<li class="step${state}"${step === current ? ' aria-current="step"' : ""}>${label}</li>`;
  }).join("");
  return `<ol class="steps">${items}</ol>`;
}

// Поля шага. Всё, что ввёл зритель, попадает в разметку только через escapeHTML.
function stepFields(step: 1 | 2 | 3, draft: Draft): string {
  if (step === 1) {
    const options = suppliers
      .map(
        (name) =>
          `<option${name === draft.supplier ? " selected" : ""}>${escapeHTML(name)}</option>`,
      )
      .join("");
    return `<div class="fields-grid">
      <label class="field">
        <span class="field__label">Поставщик</span>
        <select name="supplier" required><option value="">Выберите поставщика</option>${options}</select>
      </label>
      <label class="field">
        <span class="field__label">Номер накладной</span>
        <input name="number" value="${escapeHTML(draft.number)}" placeholder="ТН-2026-0420" maxlength="${LIMITS.number}" required />
      </label>
    </div>`;
  }
  if (step === 2) {
    return `<div class="fields-grid">
      <label class="field">
        <span class="field__label">Сумма, ₽</span>
        <input type="number" name="amount" min="0.01" step="0.01" max="999999999" value="${escapeHTML(draft.amount)}" required />
      </label>
      <label class="field">
        <span class="field__label">Оплатить до</span>
        <input type="date" name="dueDate" value="${escapeHTML(draft.dueDate)}" required />
      </label>
    </div>`;
  }
  return `<table class="pairs">
    <tbody>
      <tr><th>Поставщик</th><td>${escapeHTML(draft.supplier)}</td></tr>
      <tr><th>Накладная</th><td>${escapeHTML(draft.number)}</td></tr>
      <tr><th>Сумма</th><td class="num">${money.format(Number(draft.amount))}</td></tr>
      <tr><th>Оплатить до</th><td>${escapeHTML(draft.dueDate.split("-").reverse().join("."))}</td></tr>
    </tbody>
  </table>`;
}

function wizardScreen(
  context: Context,
  step: 1 | 2 | 3,
  draftId: string,
  draft: Draft,
  error?: string,
): string {
  const back =
    step > 1
      ? `<a href="./?draft=${encodeURIComponent(draftId)}&amp;step=${step - 1}">Назад</a>`
      : "";
  const next = step === 3 ? "Зарегистрировать" : "Далее";
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    body: `
      <div class="stack">
        ${stepsBar(step)}
        <section class="card card--pad">
          <form class="stack" method="post" action="./">
            <input type="hidden" name="draft" value="${escapeHTML(draftId)}" />
            <input type="hidden" name="step" value="${step}" />
            ${stepFields(step, draft)}
            ${error ? `<p class="status status--error" role="alert">${escapeHTML(error)}</p>` : ""}
            <p class="actions">${back}<button class="btn-primary" type="submit">${next}</button></p>
          </form>
        </section>
      </div>`,
  });
}

function validate(step: 1 | 2 | 3, draft: Draft): string | undefined {
  const tooLong = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).find(
    (name) => draft[name].length > LIMITS[name],
  );
  if (tooLong) return `Поле «${FIELD_LABELS[tooLong]}» длиннее ${LIMITS[tooLong]} символов.`;
  if (step === 1) {
    if (!suppliers.includes(draft.supplier)) return "Выберите поставщика из списка.";
    if (!draft.number) return "Укажите номер накладной.";
  }
  if (step === 2) {
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0) return "Сумма — число больше нуля.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)) return "Укажите срок оплаты.";
  }
  return undefined;
}

ui.get("/", (context) => {
  const done = registered.find((invoice) => String(invoice.id) === context.req.query("done"));
  if (done) {
    return context.html(
      appPage({
        title: appTitle(context.req.raw, APP_NAME),
        request: context.req.raw,
        style: APP_STYLE,
        body: `
          <div class="stack">
            ${stepsBar(STEPS.length + 1)}
            <section class="card card--pad stack">
              <p class="status status--ok">Накладная ${escapeHTML(done.number)} зарегистрирована</p>
              <p class="hint">${escapeHTML(done.supplier)} · ${money.format(done.amount)}</p>
              <p class="actions"><a href="./">Зарегистрировать ещё одну</a></p>
            </section>
          </div>`,
      }),
    );
  }
  // Шаг и черновик живут в адресе: «Назад» браузера и ссылка «Назад» ведут на
  // тот же шаг с уже введёнными данными. Неизвестный черновик — начало мастера.
  const draftId = context.req.query("draft") ?? "";
  const draft = drafts.get(draftId);
  if (!draft) return context.html(wizardScreen(context, 1, randomUUID(), emptyDraft()));
  return context.html(
    wizardScreen(context, reachableStep(stepOf(context.req.query("step")), draft), draftId, draft),
  );
});

// Шаг из адреса не дальше первого незаполненного: иначе ручной ?step=3 показал
// бы проверку пустой накладной.
function reachableStep(step: 1 | 2 | 3, draft: Draft): 1 | 2 | 3 {
  if (step > 1 && validate(1, draft)) return 1;
  if (step > 2 && validate(2, draft)) return 2;
  return step;
}

function emptyDraft(): Draft {
  return { supplier: "", number: "", amount: "", dueDate: "" };
}

// POST → redirect (303): обновление страницы не отправляет шаг повторно.
// Адреса переходов относительные — приложение живёт под /{slug}/.
ui.post("/", async (context) => {
  const form = await context.req.parseBody();
  const text = (name: string): string => {
    const value = form[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const draftId = text("draft");
  if (!/^[0-9a-f-]{36}$/.test(draftId)) return context.redirect("./", 303);
  const step = stepOf(text("step"));
  // Правка идёт в копию: отклонённый ввод не должен попасть в сохранённый черновик.
  const draft = { ...(drafts.get(draftId) ?? emptyDraft()) };
  if (step === 1) Object.assign(draft, { supplier: text("supplier"), number: text("number") });
  if (step === 2) Object.assign(draft, { amount: text("amount"), dueDate: text("dueDate") });
  // Итоговая регистрация перепроверяет оба шага: черновик мог прийти не по порядку.
  const error = step === 3 ? (validate(1, draft) ?? validate(2, draft)) : validate(step, draft);
  if (error) return context.html(wizardScreen(context, step, draftId, draft, error), 422);

  drafts.delete(draftId);
  if (step === 3) {
    const id = nextId++;
    registered.push({
      id,
      number: draft.number,
      supplier: draft.supplier,
      amount: Number(draft.amount),
      dueDate: draft.dueDate,
    });
    if (registered.length > MAX_REGISTERED)
      registered.splice(0, registered.length - MAX_REGISTERED);
    return context.redirect(`./?done=${id}`, 303);
  }
  // Повторная вставка переносит черновик в конец Map: вытесняются самые давние.
  drafts.set(draftId, draft);
  if (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value!);
  return context.redirect(`./?draft=${encodeURIComponent(draftId)}&step=${step + 1}`, 303);
});

app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
