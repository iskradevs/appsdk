import { appPage, appTitle, escapeHTML } from "@iskra/apps";
import type { Context } from "hono";
import { APP_NAME, APP_STYLE } from "./config.js";
import { STEPS, suppliers, LIMITS, type Draft, type Registered } from "./data.js";

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });

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

export function wizardScreen(
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

export function completedScreen(context: Context, done: Registered): string {
  return appPage({
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
  });
}
