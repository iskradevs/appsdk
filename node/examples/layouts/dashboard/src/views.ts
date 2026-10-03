import { appPage, appTitle, escapeHTML } from "@iskra/apps";
import type { Context } from "hono";
import { APP_NAME, APP_STYLE } from "./config.js";
import { metrics, operations } from "./data.js";

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

export function screen(context: Context): string {
  const totals = metrics();
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
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    body: `
        <div class="stack">
          <section class="kpis" aria-label="Сентябрь 2026">
            ${kpi("Накладных за месяц", String(totals.received))}
            ${kpi("Оплачено", money.format(totals.paid))}
            ${kpi("Просрочено к оплате", money.format(totals.overdue))}
          </section>
          <h2 class="section__title">Последние операции</h2>
          <section class="card table-wrap">
            <table>
              <thead><tr><th>Дата</th><th>Операция</th><th>Поставщик</th><th class="num">Сумма</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </section>
        </div>`,
  });
}
