import { APP_STYLESHEET_PATH, appStylesheetResponse } from "@iskra/apps";
import { Hono } from "hono";
import { selectedSupplier } from "./data.js";
import { screen } from "./views.js";

export function createRoutes(): Hono {
  const ui = new Hono();
  ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));
  ui.get("/", (context) => {
    const selected = selectedSupplier(context.req.query("id"));
    return context.html(screen(context, selected), selected ? 200 : 404);
  });
  return ui;
}
