import { appDataPath } from "@iskra/apps";
import { DatabaseSync } from "node:sqlite";

export interface Note {
  readonly id: number;
  readonly text: string;
}

const db = new DatabaseSync(appDataPath("notes.sqlite"));
db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");

export function notes(): { id: number; text: string }[] {
  return db.prepare("SELECT id, text FROM notes ORDER BY id DESC").all() as {
    id: number;
    text: string;
  }[];
}

export function createNote(text: string): Note {
  const result = db.prepare("INSERT INTO notes (text) VALUES (?)").run(text);
  return { id: Number(result.lastInsertRowid), text };
}
