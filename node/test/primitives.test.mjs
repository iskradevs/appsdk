import assert from "node:assert/strict";
import test from "node:test";

import { appBasePath, appDataPath, hashPassword, newSession, verifyPassword, verifySession } from "../dist/index.js";

test("base path и volume helpers нормализуют platform env", () => {
  assert.equal(appBasePath({ APP_BASE_PATH: "/notes/" }), "/notes");
  assert.equal(appBasePath({ APP_BASE_PATH: "/" }), "/");
  assert.equal(appDataPath("state.sqlite", { DATA_DIR: "/data" }), "/data/state.sqlite");
  assert.throws(() => appDataPath("../foreign", { DATA_DIR: "/data" }));
});

test("password hash и signed session не хранят исходный секрет", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong", encoded), false);
  assert.equal(encoded.includes("correct horse"), false);

  const session = newSession("viewer-1", "session-secret");
  assert.equal(verifySession(session, "session-secret"), "viewer-1");
  assert.equal(verifySession(`${session}x`, "session-secret"), null);
});
