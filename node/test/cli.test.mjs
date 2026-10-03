import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildApp,
  packApp,
  PublicationFailedError,
  publishApp,
  scaffoldApp,
} from "../dist/cli-core.js";
import { APP_LAYOUTS } from "../dist/starter.js";

const sdkRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

const layoutExamples = APP_LAYOUTS.map((id) => join("layouts", id));

test("authoring examples are complete closed-set apps", async () => {
  for (const name of ["minimal", "interactive", "stateful", ...layoutExamples]) {
    const root = await mkdtemp(join(tmpdir(), `iskra-sdk-example-${name.replaceAll(sep, "-")}-`));
    await cp(join(sdkRoot, "examples", name), root, { recursive: true });
    await buildApp(root, { closedDependencies: true });
  }
});

// Узел проверяет кандидата на публикацию запросом в корень приложения СО
// слэшем ("/{slug}/"), и роутер водит туда же зрителей. Hono по умолчанию
// считает "/{slug}" и "/{slug}/" разными путями, поэтому строгий роутер
// отвечает пробе 404 — приложение, собранное по образцу, не публикуется вовсе.
// Проверка стоит на образцах: именно их копирует автор, и цена ошибки здесь —
// не один сломанный экран, а каждое новое приложение.
test("authoring templates mount the app on a slash-tolerant router", async () => {
  const sources = [];
  for (const name of ["minimal", "interactive", "stateful", ...layoutExamples]) {
    sources.push([name, await readFile(join(sdkRoot, "examples", name, "src/server.ts"), "utf8")]);
  }
  const scaffoldRoot = await mkdtemp(join(tmpdir(), "iskra-sdk-scaffold-router-"));
  await scaffoldApp(scaffoldRoot, { name: "demo" });
  sources.push(["scaffold", await readFile(join(scaffoldRoot, "src/server.ts"), "utf8")]);

  for (const [name, source] of sources) {
    assert.match(
      source,
      /const app = new Hono\(\{ strict: false \}\);/,
      `${name}: корневой роутер отвергнет "/{slug}/" и провалит гейт публикации`,
    );
  }
});

// Макет копирует `iskra-app init --layout`, подменяя имя и стиль по строкам
// APP_NAME и APP_STYLE: вторая такая строка или её отсутствие сломали бы
// заготовку. Политика содержимого запрещает атрибут style и встроенные
// <script>/<style> — образец с ними показал бы автору неработающий приём.
test("layout examples expose one name and style line and obey the content policy", async () => {
  for (const id of APP_LAYOUTS) {
    const root = join(sdkRoot, "examples", "layouts", id);
    const manifest = JSON.parse(await readFile(join(root, "app.json"), "utf8"));
    assert.equal(manifest.name, `layout-${id}`);
    const source = await readFile(join(root, "src/server.ts"), "utf8");
    assert.equal(
      source.match(/^const APP_NAME = "[^"]*";$/gm)?.length,
      1,
      `${id}: строка APP_NAME обязана встретиться ровно один раз`,
    );
    assert.ok(source.includes(`const APP_NAME = "layout-${id}";`), `${id}: APP_NAME`);
    assert.equal(
      source.match(/^const APP_STYLE: AppStyle = "[^"]*";$/gm)?.length,
      1,
      `${id}: строка APP_STYLE обязана встретиться ровно один раз`,
    );
    assert.ok(source.includes('const APP_STYLE: AppStyle = "iskra";'), `${id}: APP_STYLE`);
    assert.doesNotMatch(source, /\sstyle=/, `${id}: атрибут style запрещён политикой`);
    assert.doesNotMatch(source, /<script(?![^>]*\ssrc=)|<style/, `${id}: встроенный код запрещён`);
    assert.match(source, /request: context\.req\.raw/, `${id}: шапке нужен запрос зрителя`);
  }
});

test("init --layout copies the layout example under the new name and style", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await scaffoldApp(root, { name: "crm", layout: "table", style: "strict" });
  const manifest = JSON.parse(await readFile(join(root, "app.json"), "utf8"));
  assert.equal(manifest.name, "crm");
  const source = await readFile(join(root, "src/server.ts"), "utf8");
  assert.match(source, /^const APP_NAME = "crm";$/m);
  assert.match(source, /^const APP_STYLE: AppStyle = "strict";$/m);
  assert.doesNotMatch(source, /layout-table/);
  const example = await readFile(join(sdkRoot, "examples/layouts/table/src/server.ts"), "utf8");
  assert.equal(
    source,
    example
      .replace('const APP_NAME = "layout-table";', 'const APP_NAME = "crm";')
      .replace('const APP_STYLE: AppStyle = "iskra";', 'const APP_STYLE: AppStyle = "strict";'),
  );
  await buildApp(root, { closedDependencies: true });
});

test("init without layout keeps the minimal scaffold wired to the viewer request", async (t) => {
  const plain = await mkdtemp(join(tmpdir(), "iskra-sdk-plain-"));
  const showcase = await mkdtemp(join(tmpdir(), "iskra-sdk-showcase-"));
  t.after(() => rm(plain, { recursive: true, force: true }));
  t.after(() => rm(showcase, { recursive: true, force: true }));
  await scaffoldApp(plain, { name: "plain" });
  const plainSource = await readFile(join(plain, "src/server.ts"), "utf8");
  assert.match(plainSource, /request: context\.req\.raw/);
  assert.doesNotMatch(plainSource, /style: "/);
  await scaffoldApp(showcase, { name: "shiny", style: "showcase" });
  const showcaseSource = await readFile(join(showcase, "src/server.ts"), "utf8");
  assert.match(showcaseSource, /style: "showcase"/);
  await buildApp(showcase, { closedDependencies: true });
});

test("init rejects an unknown layout or style with the allowed list", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => scaffoldApp(join(root, "a"), { name: "a", layout: "kanban" }),
    /kanban[^]*form, table, dashboard, master-detail, sidebar, wizard/,
  );
  await assert.rejects(
    () => scaffoldApp(join(root, "b"), { name: "b", style: "neon" }),
    /neon[^]*iskra, strict, showcase/,
  );
});

test("init CLI rejects an empty layout or style instead of the minimal scaffold", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-empty-flag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(sdkRoot, "dist/cli.js");
  for (const [flag, dir] of [["--layout", "a"], ["--style", "b"]]) {
    await assert.rejects(
      () => execFileAsync(process.execPath, [cli, "init", "--name", "x", "--path", join(root, dir), flag, ""]),
      (error) => {
        assert.match(error.stderr, /допустимы/);
        return true;
      },
    );
    await assert.rejects(() => readFile(join(root, dir, "src/server.ts")), { code: "ENOENT" });
  }
});

test("Stage F scenario fixture has two healthy versions and one exact failed probe", async (t) => {
  const fixtureRoot = join(sdkRoot, "examples", "stage-f-scenario");
  const buildsRoot = await mkdtemp(join(tmpdir(), "iskra-sdk-stage-f-"));
  t.after(() => rm(buildsRoot, { recursive: true, force: true }));
  const versions = ["1.0.0", "1.1.0", "9.9.9-bad"];

  for (const version of versions) {
    const sourceProject = join(fixtureRoot, version);
    const manifest = JSON.parse(await readFile(join(sourceProject, "app.json"), "utf8"));
    assert.equal(manifest.name, "stage-f-demo");
    assert.equal(manifest.version, version);
    assert.equal(manifest.access, "private");
    const project = join(buildsRoot, version);
    await cp(sourceProject, project, { recursive: true });
    await buildApp(project, { closedDependencies: true });

    const source = await readFile(join(sourceProject, "src", "server.ts"), "utf8");
    if (version === "9.9.9-bad") {
      assert.match(source, /app\.get\("\/healthz"[^]*503/);
      assert.doesNotMatch(source, /iskra-apps-stage-f-result/);
      continue;
    }
    const markerPosition = source.indexOf("ISKRA_APPS_STAGE_F_OK");
    const animationFramePosition = source.indexOf("requestAnimationFrame");
    assert.ok(markerPosition >= 0, `${version}: visible marker is missing`);
    assert.ok(
      animationFramePosition > markerPosition,
      `${version}: observation must start only after the marker is rendered`,
    );
    assert.match(source, /params\.get\("iskra_stage_f_nonce"\)/);
    assert.match(source, /params\.get\("iskra_stage_f_return_origin"\)/);
    assert.match(source, /type: "iskra-apps-stage-f-result"/);
    assert.match(source, /value: "ISKRA_APPS_STAGE_F_OK"/);
    assert.match(source, /nonce,/);
    assert.match(source, /window\.opener\.postMessage\([^]*trustedOrigin/);
  }

  const recipe = await readFile(join(fixtureRoot, "README.md"), "utf8");
  assert.match(recipe, /user1@test\.invalid/);
  assert.match(recipe, /1\.0\.0[^]*1\.1\.0[^]*9\.9\.9-bad/);
  assert.match(recipe, /popup/i);
  assert.doesNotMatch(recipe, /ISKRA_API_KEY\s*=/);
});

test("CLI scaffolds, builds and deterministically packs a closed-set app", async () => {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-cli-"));
  const project = join(root, "notes");
  await scaffoldApp(project, { name: "notes" });
  const source = await readFile(join(project, "src", "server.ts"), "utf8");
  assert.match(source, /app\.get\("\/healthz"/);
  assert.match(source, /app\.route\(appBasePath\(\), ui\)/);
  const manifest = JSON.parse(await readFile(join(project, "app.json"), "utf8"));
  assert.equal(manifest.entry, "server.js");

  // Каркас нового приложения обязан выходить оформленным: экран без стиля —
  // это то, с чем автор остаётся, если слой подключается «по желанию».
  assert.match(source, /appStylesheetResponse/);
  assert.match(source, /appPage\(/);
  assert.match(source, /appTitle\(/);

  const buildDir = await buildApp(project, { closedDependencies: true });
  const bundle = await readFile(join(buildDir, "server.js"), "utf8");
  assert.match(bundle, /healthz/);
  // Общий слой едет внутри бандла, а не подтягивается с узла: вид published
  // версии не меняется от того, что платформу обновили.
  assert.match(bundle, /--accent:/);
  const first = join(root, "first.zip");
  const second = join(root, "second.zip");
  await packApp(buildDir, first);
  await packApp(buildDir, second);
  assert.deepEqual(await readFile(first), await readFile(second));
});

test("closed build rejects every undeclared bare import", async () => {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-closed-"));
  await scaffoldApp(root, { name: "closed" });
  await writeFile(
    join(root, "src/server.ts"),
    'import leftPad from "left-pad"; console.log(leftPad);',
  );
  await assert.rejects(
    () => buildApp(root, { closedDependencies: true }),
    /закрытый набор зависимостей/,
  );
});

test("closed build rejects an absolute import outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-closed-absolute-"));
  await scaffoldApp(root, { name: "closed-absolute" });
  const forbidden = join(sdkRoot, "node_modules", "ajv", "dist", "ajv.js");
  await writeFile(join(root, "src/server.ts"), `import ${JSON.stringify(forbidden)};`);
  await assert.rejects(
    () => buildApp(root, { closedDependencies: true }),
    /absolute|закрытый набор|вне проекта/,
  );
});

test("closed build rejects a relative import escaping the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-closed-relative-"));
  await scaffoldApp(root, { name: "closed-relative" });
  const forbidden = join(sdkRoot, "node_modules", "ajv", "dist", "ajv.js");
  let escaped = relative(join(root, "src"), forbidden).split(sep).join("/");
  if (!escaped.startsWith(".")) escaped = `./${escaped}`;
  await writeFile(join(root, "src/server.ts"), `import ${JSON.stringify(escaped)};`);
  await assert.rejects(
    () => buildApp(root, { closedDependencies: true }),
    /закрытый набор|вне проекта/,
  );
});

test("closed build never treats a project inside SDK dist as trusted toolchain", async (t) => {
  const root = await mkdtemp(join(sdkRoot, "dist", "iskra-sdk-user-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await scaffoldApp(root, { name: "closed-nested" });
  await writeFile(join(root, "src/server.ts"), 'import Ajv from "ajv"; console.log(Ajv);');
  await assert.rejects(
    () => buildApp(root, { closedDependencies: true }),
    /закрытый набор зависимостей/,
  );
});

test("closed build accepts a project directory reached through a symlink", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "iskra-sdk-project-link-"));
  const project = join(parent, "real-project");
  const projectLink = join(parent, "project-link");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await scaffoldApp(project, { name: "linked-project" });
  await symlink(project, projectLink, "dir");
  await buildApp(projectLink, { closedDependencies: true });
});

for (const variant of ["extensionless", "directory-index", "directory-main", "node-modules-link"]) {
  test(`closed build checks the resolved source boundary for ${variant}`, async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "iskra-sdk-resolved-boundary-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const project = join(parent, "project");
    await scaffoldApp(project, { name: "closed-boundary" });
    const outside = variant === "node-modules-link"
      ? join(project, "node_modules", "unapproved", "payload.ts")
      : join(parent, "payload.ts");
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, 'export const payload = "outside source root";');
    if (variant === "directory-index" || variant === "directory-main") {
      await mkdir(join(project, "src", "payload"));
      await symlink(outside, join(project, "src", "payload", "index.ts"));
      if (variant === "directory-main") {
        await writeFile(join(project, "src", "payload", "package.json"), JSON.stringify({ main: "index.ts" }));
      }
    } else {
      await symlink(outside, join(project, "src", "payload.ts"));
    }
    await writeFile(join(project, "src", "server.ts"), 'import { payload } from "./payload"; console.log(payload);');
    await assert.rejects(() => buildApp(project, { closedDependencies: true }), /вне проекта|node_modules/);
  });
}

test("closed build accepts extensionless and directory imports within source root", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "iskra-sdk-resolved-allowed-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await scaffoldApp(project, { name: "closed-allowed" });
  await mkdir(join(project, "src", "folder"));
  await writeFile(join(project, "src", "value.ts"), 'export const value = "allowed";');
  await writeFile(join(project, "src", "folder", "index.ts"), 'export { value } from "../value";');
  await writeFile(join(project, "src", "server.ts"), 'import { value } from "./folder"; console.log(value);');
  await buildApp(project, { closedDependencies: true });
  assert.match(await readFile(join(project, ".iskra-build", "server.js"), "utf8"), /allowed/);
});

test("packed SDK builds with hoisted dependencies but keeps user imports closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-packed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "packed-sdk-test", private: true, type: "module" })}\n`,
  );
  const packed = await execFileAsync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    { cwd: sdkRoot },
  );
  const [{ filename }] = JSON.parse(packed.stdout);
  // prefer-offline, а не offline: установка собранного пакета разрешает его
  // зависимости, то есть просит у реестра метаданные. Их не кладёт в кеш npm ci
  // — он берёт адреса из lock и качает только тарболы, — поэтому на раннере с
  // кешем от npm ci строгий offline падает с ENOTCACHED. Кеш по-прежнему
  // используется, в сеть уходит только то, чего в нём нет.
  await execFileAsync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      join(root, filename),
    ],
    { cwd: root },
  );
  const installedCore = await import(
    pathToFileURL(join(root, "node_modules/@iskra/apps/dist/cli-core.js")).href
  );
  await installedCore.scaffoldApp(root, { name: "packed-sdk" });
  await installedCore.buildApp(root, { closedDependencies: true });
  // Макеты читаются из examples установленного пакета: путь от dist/cli-core.js.
  const layoutProject = join(root, "layout-project");
  await installedCore.scaffoldApp(layoutProject, { name: "packed-layout", layout: "wizard" });
  assert.match(
    await readFile(join(layoutProject, "src/server.ts"), "utf8"),
    /^const APP_NAME = "packed-layout";$/m,
  );

  await writeFile(join(root, "src/server.ts"), 'import Ajv from "ajv"; console.log(Ajv);');
  await assert.rejects(
    () => installedCore.buildApp(root, { closedDependencies: true }),
    /закрытый набор зависимостей/,
  );

  await writeFile(
    join(root, "src/server.ts"),
    'import "../node_modules/jose/dist/webapi/index.js";',
  );
  await assert.rejects(
    () => installedCore.buildApp(root, { closedDependencies: true }),
    /закрытый набор|node_modules|вне проекта/,
  );

  await symlink(join(root, "node_modules/jose"), join(root, "src/jose-link"), "dir");
  await writeFile(join(root, "src/server.ts"), 'import "./jose-link/dist/webapi/index.js";');
  await assert.rejects(
    () => installedCore.buildApp(root, { closedDependencies: true }),
    /закрытый набор|node_modules|через ссылку/,
  );

  const forbiddenEntry = join(root, "node_modules/forbidden/index.js");
  await mkdir(dirname(forbiddenEntry), { recursive: true });
  await writeFile(join(root, "node_modules/forbidden/package.json"), '{"name":"forbidden"}');
  await writeFile(forbiddenEntry, 'console.log("forbidden entry");');
  await rm(join(root, "src/server.ts"));
  await symlink(forbiddenEntry, join(root, "src/server.ts"));
  await assert.rejects(
    () => installedCore.buildApp(root, { closedDependencies: true }),
    /entry|node_modules|absolute/,
  );
});

test("CLI publishes with apps:publish API key and polls renderer result", async () => {
  const requests = [];
  let polls = 0;
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    for await (const _ of request) {
      /* drain multipart */
    }
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      response.statusCode = 202;
      response.end(JSON.stringify({ id: "app-1", version: "1.0.0", state: "probing" }));
      return;
    }
    polls += 1;
    response.end(
      JSON.stringify(
        polls === 1
          ? { publication: { version: "1.0.0", state: "pending", activate_on_ready: true } }
          : {
              current_version: "1.0.0",
              publication: { version: "1.0.0", state: "ready", activate_on_ready: true },
            },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => server.close());
  const address = server.address();

  const bundle = new Blob(["bundle"]);
  const result = await publishApp(bundle, {
    apiUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "isk_secret",
    pollIntervalMs: 1,
    timeoutMs: 1000,
  });
  assert.equal(result.state, "ready");
  assert.equal(requests[0].url, "/api/v1/apps?activate=true");
  assert.ok(requests.every((request) => request.authorization === "Bearer isk_secret"));
});

test("CLI preserves --no-activate intent when creating an app", async () => {
  let requestedURL = "";
  const fetch = async (url) => {
    requestedURL = String(url);
    return Response.json(
      { id: "app-new", version: "1.0.0", state: "ready", activated: false },
      { status: 201 },
    );
  };
  const result = await publishApp(new Blob(["bundle"]), {
    apiUrl: "http://iskra.invalid",
    apiKey: "isk_secret",
    activate: false,
    fetch,
  });
  assert.equal(requestedURL, "http://iskra.invalid/api/v1/apps?activate=false");
  assert.equal(result.activated, false);
  assert.equal(result.state, "ready");
});

test("CLI reports a ready version that public approval kept inactive", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({ id: "app-1", version: "2.0.0", state: "probing" }, { status: 202 });
    }
    return Response.json({
      access: "public",
      current_version: "1.0.0",
      approved_version: "1.0.0",
      publication: { version: "2.0.0", state: "ready", activate_on_ready: true },
    });
  };

  const result = await publishApp(new Blob(["bundle"]), {
    apiUrl: "http://iskra.invalid",
    apiKey: "isk_secret",
    appId: "app-1",
    pollIntervalMs: 1,
    timeoutMs: 1000,
    fetch,
  });
  assert.deepEqual(result, {
    appId: "app-1",
    version: "2.0.0",
    state: "ready_not_active",
    currentVersion: "1.0.0",
    activated: false,
    approvalPending: true,
  });
});

test("CLI timeout after acceptance returns durable probing identifiers", async () => {
  let calls = 0;
  const fetch = async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { id: "app-durable", version: "3.0.0", state: "probing" },
        { status: 202 },
      );
    }
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };

  const result = await publishApp(new Blob(["bundle"]), {
    apiUrl: "http://iskra.invalid",
    apiKey: "isk_secret",
    pollIntervalMs: 1,
    timeoutMs: 20,
    fetch,
  });
  assert.deepEqual(result, {
    appId: "app-durable",
    version: "3.0.0",
    state: "probing",
    activated: false,
    approvalPending: false,
  });
});

test("CLI resumes a terminal outcome from a pruned version tombstone", async () => {
  const requested = [];
  const fetch = async (url) => {
    requested.push(String(url));
    if (requested.length === 1) {
      return Response.json(
        { id: "app-pruned", version: "2.0.0", state: "probing" },
        { status: 202 },
      );
    }
    return Response.json({
      current_version: "12.0.0",
      publication: {
        version: "2.0.0",
        state: "pruned",
        activate_on_ready: false,
        outcome: "not_requested",
      },
    });
  };

  const result = await publishApp(new Blob(["bundle"]), {
    apiUrl: "http://iskra.invalid",
    apiKey: "isk_secret",
    appId: "app-pruned",
    activate: false,
    pollIntervalMs: 1,
    timeoutMs: 1000,
    fetch,
  });
  assert.equal(requested[1], "http://iskra.invalid/api/v1/apps/app-pruned?version=2.0.0");
  assert.deepEqual(result, {
    appId: "app-pruned",
    version: "2.0.0",
    state: "ready",
    currentVersion: "12.0.0",
    activated: false,
    approvalPending: false,
  });
});

test("CLI preserves activation outcome after a newer version becomes current", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { id: "app-history", version: "2.0.0", state: "probing" },
        { status: 202 },
      );
    }
    return Response.json({
      current_version: "3.0.0",
      publication: {
        version: "2.0.0",
        state: "ready",
        activate_on_ready: true,
        outcome: "activated",
      },
    });
  };
  const result = await publishApp(new Blob(["bundle"]), {
    apiUrl: "http://iskra.invalid",
    apiKey: "isk_secret",
    appId: "app-history",
    pollIntervalMs: 1,
    timeoutMs: 1000,
    fetch,
  });
  assert.deepEqual(result, {
    appId: "app-history",
    version: "2.0.0",
    state: "ready",
    currentVersion: "3.0.0",
    activated: true,
    approvalPending: false,
  });
});

test("CLI reports top-level problem+json code", async () => {
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      /* drain multipart */
    }
    response.statusCode = 403;
    response.setHeader("content-type", "application/problem+json");
    response.end(
      JSON.stringify({ code: "insufficient_scope", title: "insufficient_scope", status: 403 }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => server.close());
  const address = server.address();

  await assert.rejects(
    publishApp(new Blob(["bundle"]), {
      apiUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "isk_secret",
    }),
    /insufficient_scope/,
  );
});

test("CLI probe failure raises a typed error with durable app identity", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({ id: "app-probe", version: "1.2.3", state: "probing" }, { status: 202 });
    }
    return Response.json({
      publication: { version: "1.2.3", state: "pending", probe_error: "healthz вернул 503" },
    });
  };
  await assert.rejects(
    publishApp(new Blob(["bundle"]), {
      apiUrl: "http://iskra.invalid",
      apiKey: "isk_secret",
      pollIntervalMs: 1,
      timeoutMs: 1000,
      fetch,
    }),
    (error) => {
      assert.ok(error instanceof PublicationFailedError);
      assert.equal(error.appId, "app-probe");
      assert.equal(error.version, "1.2.3");
      assert.equal(error.detail, "healthz вернул 503");
      assert.match(error.message, /проверка публикации не пройдена/);
      return true;
    },
  );
});

test("CLI retries transient poll failures and still reaches the terminal state", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({ id: "app-flaky", version: "1.0.0", state: "probing" }, { status: 202 });
    }
    if (calls === 2) return Response.json({ detail: "bad gateway" }, { status: 502 });
    if (calls === 3) throw new TypeError("fetch failed");
    return Response.json({
      current_version: "1.0.0",
      publication: { version: "1.0.0", state: "ready", activate_on_ready: true },
    });
  };
  const result = await publishApp(new Blob(["bundle"]), {
    apiUrl: "http://iskra.invalid",
    apiKey: "isk_secret",
    pollIntervalMs: 1,
    timeoutMs: 5000,
    fetch,
  });
  assert.equal(calls, 4);
  assert.deepEqual(result, {
    appId: "app-flaky",
    version: "1.0.0",
    state: "ready",
    currentVersion: "1.0.0",
    activated: true,
    approvalPending: false,
  });
});

test("CLI treats a 4xx poll response as fatal without retries", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { id: "app-denied", version: "2.0.0", state: "probing" },
        { status: 202 },
      );
    }
    return Response.json({ detail: "insufficient_scope" }, { status: 403 });
  };
  await assert.rejects(
    publishApp(new Blob(["bundle"]), {
      apiUrl: "http://iskra.invalid",
      apiKey: "isk_secret",
      pollIntervalMs: 1,
      timeoutMs: 1000,
      fetch,
    }),
    (error) => {
      assert.ok(error instanceof PublicationFailedError);
      assert.equal(error.appId, "app-denied");
      assert.equal(error.version, "2.0.0");
      assert.equal(error.detail, "insufficient_scope");
      assert.match(error.message, /публикация не выполнена/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("CLI rejects unknown flags on every subcommand", async () => {
  const cli = join(sdkRoot, "dist", "cli.js");
  const cases = [
    ["init", "--nam", "notes"],
    ["check", "--paht", "."],
    ["build", "--close"],
    ["pack", "--outpt", "out.zip"],
    ["source-pack", "--unknown"],
    ["publish", "--appid", "app-1"],
  ];
  for (const [command, ...badArgs] of cases) {
    await assert.rejects(
      execFileAsync(process.execPath, [cli, command, ...badArgs]),
      (error) => {
        assert.equal(error.code, 1, `${command}: ожидался ненулевой exit-код`);
        assert.match(error.stderr, /неизвестный аргумент/, `${command}: stderr=${error.stderr}`);
        assert.ok(
          error.stderr.includes(badArgs[0]),
          `${command}: stderr должен назвать ${badArgs[0]}: ${error.stderr}`,
        );
        assert.match(error.stderr, /допустимо/, `${command}: stderr без подсказки`);
        return true;
      },
    );
  }
});

test("CLI publish prints durable identity when the probe fails", async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      /* drain multipart */
    }
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      response.statusCode = 202;
      response.end(JSON.stringify({ id: "app-e2e", version: "0.1.0", state: "probing" }));
      return;
    }
    response.end(
      JSON.stringify({
        publication: { version: "0.1.0", state: "pending", probe_error: "healthz недоступен" },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();

  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-cli-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "probe-fail");
  await scaffoldApp(project, { name: "probe-fail" });

  const failure = await execFileAsync(
    process.execPath,
    [join(sdkRoot, "dist", "cli.js"), "publish", "--path", project, "--closed"],
    {
      env: {
        ...process.env,
        ISKRA_API_URL: `http://127.0.0.1:${address.port}`,
        ISKRA_API_KEY: "isk_secret",
      },
    },
  ).then(
    () => assert.fail("publish обязан завершиться ошибкой"),
    (error) => error,
  );
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /проверка публикации не пройдена/);
  const structured = JSON.parse(failure.stdout.trim().split("\n").at(-1));
  assert.deepEqual(structured, {
    error: "app_publication_failed",
    app_id: "app-e2e",
    version: "0.1.0",
    detail: "healthz недоступен",
  });
});

test("CLI bounds the initial publication request with the terminal deadline", async () => {
  let receivedSignal = false;
  const hangingFetch = async (_url, init) => {
    receivedSignal = init.signal instanceof AbortSignal;
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };

  await assert.rejects(
    publishApp(new Blob(["bundle"]), {
      apiUrl: "http://iskra.invalid",
      apiKey: "isk_secret",
      timeoutMs: 20,
      fetch: hangingFetch,
    }),
    /не завершилась за отведённое время/,
  );
  assert.equal(receivedSignal, true);
});


test("packed SDK public types compile in a bare consumer without Node ambient types", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-bare-types-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, "artifacts");
  const consumer = join(root, "consumer");
  await mkdir(artifacts);
  await mkdir(consumer);
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", artifacts], { cwd: sdkRoot });
  const [{ filename }] = JSON.parse(stdout);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "bare-sdk-type-consumer", version: "1.0.0", private: true, type: "module",
  }));
  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(artifacts, filename)], { cwd: consumer });
  await assert.rejects(readFile(join(consumer, "node_modules/@types/node/package.json")), { code: "ENOENT" });
  await writeFile(join(consumer, "consumer.ts"), `
import { IskraAPIError, appBasePath, appDataPath, type IskraAPIErrorMetadata } from "@iskra/apps";
const metadata: IskraAPIErrorMetadata = { title: "Busy", detail: "", requestId: "req", retryAfter: "5" };
const old: Error = new IskraAPIError(400, "invalid", "Invalid");
const current = new IskraAPIError(503, "busy", "Busy", metadata);
const requestId: string | undefined = current.requestId;
const env = Object.freeze({ APP_BASE_PATH: "/notes/", DATA_DIR: "/data" });
const basePath: string = appBasePath(env);
const dataPath: string = appDataPath("notes.sqlite", env);
void [old, requestId, basePath, dataPath];
`);
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true, exactOptionalPropertyTypes: true, module: "NodeNext", moduleResolution: "NodeNext",
      target: "ES2022", types: [], noEmit: true,
    },
    files: ["consumer.ts"],
  }));
  await execFileAsync("npx", ["--no-install", "tsc", "--project", "tsconfig.json"], { cwd: consumer });
});
