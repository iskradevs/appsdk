import { APP_STYLESHEET_PATH, appStylesheetResponse } from "@iskra/apps";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  emptyDraft,
  findDraft,
  findRegistered,
  reachableStep,
  registerDraft,
  saveDraft,
  stepOf,
  validate,
} from "./data.js";
import { completedScreen, wizardScreen } from "./views.js";

export function createRoutes(): Hono {
  const ui = new Hono();
  ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));
  ui.get("/", (context) => {
    const done = findRegistered(context.req.query("done"));
    if (done) return context.html(completedScreen(context, done));
    // Шаг и черновик живут в адресе: «Назад» браузера и ссылка «Назад» ведут на
    // тот же шаг с уже введёнными данными. Неизвестный черновик — начало мастера.
    const draftId = context.req.query("draft") ?? "";
    const draft = findDraft(draftId);
    if (!draft) return context.html(wizardScreen(context, 1, randomUUID(), emptyDraft()));
    return context.html(
      wizardScreen(
        context,
        reachableStep(stepOf(context.req.query("step")), draft),
        draftId,
        draft,
      ),
    );
  });

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
    const draft = { ...(findDraft(draftId) ?? emptyDraft()) };
    if (step === 1) Object.assign(draft, { supplier: text("supplier"), number: text("number") });
    if (step === 2) Object.assign(draft, { amount: text("amount"), dueDate: text("dueDate") });
    // Итоговая регистрация перепроверяет оба шага: черновик мог прийти не по порядку.
    const error = step === 3 ? (validate(1, draft) ?? validate(2, draft)) : validate(step, draft);
    if (error) return context.html(wizardScreen(context, step, draftId, draft, error), 422);

    if (step === 3) {
      const id = registerDraft(draftId, draft);
      return context.redirect(`./?done=${id}`, 303);
    }
    // Повторная вставка переносит черновик в конец Map: вытесняются самые давние.
    saveDraft(draftId, draft);
    return context.redirect(`./?draft=${encodeURIComponent(draftId)}&step=${step + 1}`, 303);
  });
  return ui;
}
