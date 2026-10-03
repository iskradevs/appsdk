import { type AppPageLink, appPage, appTitle, escapeHTML } from "@iskra/apps";
import type { Context } from "hono";
import { APP_NAME, APP_STYLE } from "./config.js";
import { invoices } from "./data.js";

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
export const sections = [
  { key: "", href: "./", label: "Накладные", render: invoicesSection },
  { key: "suppliers", href: "./?section=suppliers", label: "Поставщики", render: suppliersSection },
  { key: "reports", href: "./?section=reports", label: "Отчёты", render: reportsSection },
] as const;

export function screen(context: Context, current: (typeof sections)[number] | undefined): string {
  const nav: AppPageLink[] = sections.map((section) => ({
    href: section.href,
    label: section.label,
    current: section === current,
  }));
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    nav,
    navPosition: "side",
    body: current
      ? current.render()
      : '<section class="card card--pad"><p class="empty">Такого раздела нет. Выберите раздел в меню.</p></section>',
  });
}
