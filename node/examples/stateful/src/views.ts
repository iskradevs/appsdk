import { appPage, appTitle, escapeHTML } from "@iskra/apps";
import type { Context } from "hono";
import { APP_NAME, APP_STYLE } from "./config.js";
import type { Note } from "./storage.js";

export function screen(context: Context, rows: readonly Note[]): string {
  const body = rows.length
    ? `<table>
        <thead><tr><th class="num">№</th><th>Заметка</th></tr></thead>
        <tbody>${rows
          .map(
            (note) => `<tr><td class="num">${note.id}</td><td>${escapeHTML(note.text)}</td></tr>`,
          )
          .join("")}</tbody>
      </table>`
    : '<p class="empty">Заметок пока нет.</p>';
  return appPage({
    title: appTitle(context.req.raw, APP_NAME),
    request: context.req.raw,
    style: APP_STYLE,
    body: `<section class="card table-wrap">${body}</section>`,
  });
}
