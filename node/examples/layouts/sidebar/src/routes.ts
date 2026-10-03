import { APP_STYLESHEET_PATH, appStylesheetResponse } from "@iskra/apps";
import { Hono } from "hono";
import { screen, sections } from "./views.js";

export function createRoutes(): Hono {
  const ui = new Hono();
  ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));
  ui.get("/", (context) => {
    const key = context.req.query("section") ?? "";
    const current = sections.find((section) => section.key === key);
    return context.html(screen(context, current), current ? 200 : 404);
  });
  return ui;
}
