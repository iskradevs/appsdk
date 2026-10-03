import { APP_STYLESHEET_PATH, appStylesheetResponse } from "@iskra/apps";
import { Hono } from "hono";
import {
  createRequest,
  findRequest,
  emptyValues,
  suppliers,
  LIMITS,
  FIELD_LABELS,
  type FormValues,
} from "./data.js";
import { requestForm, resultCard, screen } from "./views.js";

export function createRoutes(): Hono {
  const ui = new Hono();
  ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));
  ui.get("/", (context) => {
    const created = findRequest(context.req.query("created"));
    return context.html(
      screen(context, `${created ? resultCard(created) : ""}${requestForm(emptyValues)}`),
    );
  });

  // POST → redirect (303): обновление страницы после отправки не создаёт вторую
  // заявку. Адрес перехода относительный — приложение живёт под /{slug}/.
  ui.post("/", async (context) => {
    const form = await context.req.parseBody();
    const text = (name: keyof FormValues): string => {
      const value = form[name];
      return typeof value === "string" ? value.trim() : "";
    };
    const values: FormValues = {
      supplier: text("supplier"),
      item: text("item"),
      quantity: text("quantity"),
      deadline: text("deadline"),
      comment: text("comment"),
    };
    const quantity = Number(values.quantity);
    const tooLong = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).find(
      (name) => values[name].length > LIMITS[name],
    );
    const error = tooLong
      ? `Поле «${FIELD_LABELS[tooLong]}» длиннее ${LIMITS[tooLong]} символов.`
      : !suppliers.includes(values.supplier)
        ? "Выберите поставщика из списка."
        : !values.item
          ? "Укажите позицию."
          : !Number.isInteger(quantity) || quantity < 1
            ? "Количество — целое число больше нуля."
            : !/^\d{4}-\d{2}-\d{2}$/.test(values.deadline)
              ? "Укажите срок поставки."
              : undefined;
    if (error) return context.html(screen(context, requestForm(values, error)), 422);
    const id = createRequest(values, quantity);
    return context.redirect(`./?created=${id}`, 303);
  });
  return ui;
}
