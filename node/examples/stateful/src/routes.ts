import { APP_STYLESHEET_PATH, appStylesheetResponse } from "@iskra/apps";
import { Hono } from "hono";
import { z } from "zod";
import { createNote, notes } from "./storage.js";
import { screen } from "./views.js";

const noteInput = z.object({ text: z.string().trim().min(1).max(500) });

export function createRoutes(): Hono {
  const ui = new Hono();
  ui.get(`/${APP_STYLESHEET_PATH}`, (context) => appStylesheetResponse(context.req.raw));
  ui.get("/", (context) => context.html(screen(context, notes())));
  ui.get("/notes", (context) => context.json({ notes: notes() }));
  ui.post("/notes", async (context) => {
    const input = noteInput.parse(await context.req.json());
    return context.json(createNote(input.text), 201);
  });
  return ui;
}
