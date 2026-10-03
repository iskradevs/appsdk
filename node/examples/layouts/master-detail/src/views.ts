import { appPage, appTitle, escapeHTML } from "@iskra/apps";
import type { Context } from "hono";
import { APP_NAME, APP_STYLE } from "./config.js";
import { suppliers, type Supplier } from "./data.js";

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

export function screen(context: Context, selected: Supplier | undefined): string {
  const list = suppliers
    .map(
      (supplier) =>
        `<a class="list-select__item" href="./?id=${encodeURIComponent(supplier.id)}"${supplier === selected ? ' aria-current="true"' : ""}>${escapeHTML(supplier.name)}</a>`,
    )
    .join("");
  const card = selected
    ? detail(selected)
    : '<section class="card card--pad"><p class="empty">Поставщик не найден. Выберите его в списке.</p></section>';
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    body: `
        <div class="split">
          <nav class="list-select" aria-label="Поставщики">${list}</nav>
          ${card}
        </div>`,
  });
}
