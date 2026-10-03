import { serve } from "@hono/node-server";
import {
  APP_CSP,
  APP_STYLESHEET_PATH,
  appBasePath,
  appDataPath,
  appPage,
  appStylesheetResponse,
  escapeHTML,
} from "@iskra/apps";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const db = new DatabaseSync(appDataPath("notes.sqlite"));
db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
const noteInput = z.object({ text: z.string().trim().min(1).max(500) });
// strict: false — обязательное условие публикации: узел проверяет кандидата
// запросом в корень приложения СО слэшем ("/{slug}/"), и роутер потом водит
// туда же зрителей. Hono по умолчанию считает "/{slug}" и "/{slug}/" разными
// путями, поэтому строгий роутер отвечает пробе 404, и версия не публикуется.
const app = new Hono({ strict: false });
const ui = new Hono();

ui.use("*", async (context, next) => {
  await next();
  context.header("Content-Security-Policy", APP_CSP);
  context.header("X-Content-Type-Options", "nosniff");
});

app.get("/healthz", (context) => context.json({ ok: true }));
ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));

function notes(): { id: number; text: string }[] {
  return db.prepare("SELECT id, text FROM notes ORDER BY id DESC").all() as {
    id: number;
    text: string;
  }[];
}

// Экран собирается на сервере: списку из базы клиентский код не нужен, а без
// него нечему падать в консоли на browser-гейте публикации. Текст заметки
// пришёл снаружи, поэтому идёт в разметку только через escapeHTML.
ui.get("/", (context) => {
  const rows = notes();
  const body = rows.length
    ? `<table>
        <thead><tr><th class="num">№</th><th>Заметка</th></tr></thead>
        <tbody>${rows
          .map((note) => `<tr><td class="num">${note.id}</td><td>${escapeHTML(note.text)}</td></tr>`)
          .join("")}</tbody>
      </table>`
    : '<p class="empty">Заметок пока нет.</p>';
  return context.html(
    appPage({
      title: "Заметки",
      request: context.req.raw,
      body: `<section class="card table-wrap">${body}</section>`,
    }),
  );
});

ui.get("/notes", (context) => context.json({ notes: notes() }));
ui.post("/notes", async (context) => {
  const input = noteInput.parse(await context.req.json());
  const result = db.prepare("INSERT INTO notes (text) VALUES (?)").run(input.text);
  return context.json({ id: Number(result.lastInsertRowid), text: input.text }, 201);
});
app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
