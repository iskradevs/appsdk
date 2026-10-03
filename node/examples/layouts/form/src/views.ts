import { appPage, appTitle, escapeHTML } from "@iskra/apps";
import type { Context } from "hono";
import { APP_NAME, APP_STYLE } from "./config.js";
import { suppliers, LIMITS, type FormValues, type SupplyRequest } from "./data.js";

// Всё, что ввёл зритель, попадает в разметку только через escapeHTML — и в
// текст, и в атрибут value.
export function requestForm(values: FormValues, error?: string): string {
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

export function resultCard(request: SupplyRequest): string {
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

export function screen(context: Context, body: string): string {
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    body: `<div class="stack">${body}</div>`,
  });
}
