import { appPage, appTitle, escapeHTML } from "@iskra/apps";
import type { Context } from "hono";
import { APP_NAME, APP_STYLE } from "./config.js";
import { findInvoices, invoiceCount, type InvoiceStatus } from "./data.js";

const statusBadge: Record<InvoiceStatus, string> = {
  new: '<span class="badge badge--accent">Новая</span>',
  review: '<span class="badge">На проверке</span>',
  paid: '<span class="badge badge--success">Оплачена</span>',
  overdue: '<span class="badge badge--danger">Просрочена</span>',
};

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const date = (iso: string): string => iso.split("-").reverse().join(".");

export function screen(context: Context, query: string): string {
  const rows = findInvoices(query);
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
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    wide: true,
    body: `
        <div class="stack">
          <form class="toolbar" method="get" action="./" role="search">
            <input type="search" name="q" value="${escapeHTML(query)}" placeholder="Номер или поставщик" aria-label="Поиск накладных" />
            <span class="actions"><button type="submit">Найти</button></span>
            <p class="status">Найдено: ${rows.length} из ${invoiceCount}</p>
          </form>
          <section class="card table-wrap">${table}</section>
        </div>`,
  });
}
