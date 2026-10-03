import { APP_STYLESHEET_PATH, appStylesheetResponse } from "@iskra/apps";
import { Hono } from "hono";
import { screen } from "./views.js";

export function createRoutes(): Hono {
  const ui = new Hono();
  ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));
  ui.get("/", (context) => context.html(screen(context)));
  return ui;
}
