import { builtinModules } from "node:module";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";
import { ZipFile } from "yazl";

import { parseManifest } from "./manifest.js";
import {
  APP_LAYOUTS,
  APP_STYLES,
  type AppLayout,
  type AppStyle,
  isAppLayout,
  isAppStyle,
} from "./starter.js";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const closedPackages = new Set(["@iskra/apps", "@hono/node-server", "hono", "zod"]);
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const fixedZipTime = new Date("2000-01-01T00:00:00.000Z");
const defaultPublicationTimeoutMs = 300_000;
const maxPollBackoffMs = 30_000;

export interface ScaffoldOptions {
  readonly name: string;
  /** Макет из APP_LAYOUTS: копия examples/layouts/<id>. Без него — минимальный каркас. */
  readonly layout?: string;
  /** Стиль оформления из APP_STYLES; по умолчанию "iskra". */
  readonly style?: string;
}
export interface BuildOptions {
  readonly outDir?: string;
  readonly closedDependencies?: boolean;
}
export interface PublishOptions {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly appId?: string;
  readonly activate?: boolean;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}
export interface PublishResult {
  readonly appId: string;
  readonly version: string;
  readonly state: "ready" | "ready_not_active" | "probing";
  readonly currentVersion?: string;
  readonly activated: boolean;
  readonly approvalPending: boolean;
}

export async function scaffoldApp(projectDir: string, options: ScaffoldOptions): Promise<void> {
  const style = options.style ?? "iskra";
  if (!isAppStyle(style))
    throw new Error(`неизвестный стиль ${style}; допустимы: ${APP_STYLES.join(", ")}`);
  const layout = options.layout;
  if (layout !== undefined && !isAppLayout(layout))
    throw new Error(`неизвестный макет ${layout}; допустимы: ${APP_LAYOUTS.join(", ")}`);
  const target = resolve(projectDir);
  await mkdir(join(target, "src"), { recursive: true });
  await mkdir(join(target, "static"), { recursive: true });
  // Макет несёт свой app.json: из него меняется только имя.
  const manifest =
    layout === undefined
      ? {
          name: options.name,
          version: "0.1.0",
          entry: "server.js",
          health: true,
          access: "private",
          storage: { kind: "sqlite" },
        }
      : {
          ...(JSON.parse(await readFile(join(layoutDir(layout), "app.json"), "utf8")) as object),
          name: options.name,
        };
  parseManifest(manifest);
  await writeFile(join(target, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  if (layout === undefined) {
    await writeFile(join(target, "src/server.ts"), scaffoldServer(options.name, style), {
      flag: "wx",
    });
    return;
  }
  await copyLayoutSources(layout, target, options.name, style);
}

// Каталог макета — examples/layouts/<id> пакета; от dist/cli-core.js это
// ../examples, и npm-пакет публикует examples вместе с dist.
const layoutDir = (layout: AppLayout): string =>
  fileURLToPath(new URL(`../examples/layouts/${layout}`, import.meta.url));

// copyLayoutSources — src/** примера макета в новый проект. В server.ts
// подменяются ровно две строки-параметра: имя (запасное название экрана) и
// стиль. Остальные файлы копируются как есть; существующие не перезаписываются.
// См. docs/plans/2026-09-29-apps-ui-polish-design.md — «SDK».
async function copyLayoutSources(
  layout: AppLayout,
  target: string,
  name: string,
  style: AppStyle,
): Promise<void> {
  const sourceDir = join(layoutDir(layout), "src");
  const server = await readFile(join(sourceDir, "server.ts"), "utf8");
  const patched = replaceOnce(
    replaceOnce(
      server,
      /^const APP_NAME = "[^"]*";$/m,
      `const APP_NAME = ${JSON.stringify(name)};`,
    ),
    /^const APP_STYLE: AppStyle = "[^"]*";$/m,
    `const APP_STYLE: AppStyle = ${JSON.stringify(style)};`,
  );
  // Поэлементно: cp каталога в уже созданный src/ отказал бы на самом src/.
  for (const entry of await readdir(sourceDir)) {
    if (entry === "server.ts") continue;
    await cp(join(sourceDir, entry), join(target, "src", entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  await writeFile(join(target, "src/server.ts"), patched, { flag: "wx" });
}

// replaceOnce — замена строки-параметра, которая обязана встретиться ровно
// один раз: иначе заготовка молча осталась бы со старым именем или стилем.
function replaceOnce(source: string, pattern: RegExp, replacement: string): string {
  const matches = source.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
  if (matches?.length !== 1)
    throw new Error(`строка ${pattern.source} в макете обязана встретиться ровно один раз`);
  return source.replace(pattern, () => replacement);
}

export async function checkApp(projectDir: string): Promise<void> {
  const root = resolve(projectDir);
  parseManifest(JSON.parse(await readFile(join(root, "app.json"), "utf8")));
  const entry = join(root, "src/server.ts");
  if (!(await stat(entry)).isFile()) throw new Error("src/server.ts не является файлом");
}

export async function buildApp(projectDir: string, options: BuildOptions = {}): Promise<string> {
  const root = resolve(projectDir);
  await checkApp(root);
  const outDir = resolve(options.outDir ?? join(root, ".iskra-build"));
  assertWithin(root, outDir, "build output");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const plugins = [rejectNativeModules()];
  if (options.closedDependencies) plugins.unshift(closedDependencyPlugin(await realpath(root)));
  await build({
    entryPoints: [join(root, "src/server.ts")],
    outfile: join(outDir, "server.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: false,
    logLevel: "silent",
    plugins,
  });
  await cp(join(root, "app.json"), join(outDir, "app.json"));
  const staticDir = join(root, "static");
  if (await exists(staticDir)) await cp(staticDir, join(outDir, "static"), { recursive: true });
  return outDir;
}

export async function packApp(buildDir: string, outputPath: string): Promise<void> {
  const root = resolve(buildDir);
  await checkBundleFiles(root);
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  const files = await listFiles(root);
  const zip = new ZipFile();
  for (const path of files) {
    const name = relative(root, path).split(sep).join("/");
    zip.addBuffer(await readFile(path), name, {
      mtime: fixedZipTime,
      mode: 0o100644,
      compress: true,
    });
  }
  const done = new Promise<void>((resolveDone, reject) => {
    const outputStream = createWriteStream(output, { mode: 0o600 });
    outputStream.on("close", resolveDone);
    outputStream.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(outputStream);
  });
  zip.end({ forceZip64Format: false, comment: "" });
  await done;
}

export async function publishApp(
  bundle: Blob | Uint8Array | string,
  options: PublishOptions,
): Promise<PublishResult> {
  if (!options.apiKey.startsWith("isk_") || !options.apiUrl)
    throw new Error("apiUrl и API key формата isk_ обязательны");
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiURL = options.apiUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? defaultPublicationTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("timeoutMs обязан быть положительным конечным числом");
  const deadline = Date.now() + timeoutMs;
  const body = new FormData();
  body.set("bundle", await bundleBlob(bundle), "app.zip");
  const path = options.appId
    ? `/api/v1/apps/${encodeURIComponent(options.appId)}/versions`
    : "/api/v1/apps";
  const query = `?activate=${options.activate === false ? "false" : "true"}`;
  const response = await fetchBeforePublicationDeadline(
    fetcher,
    `${apiURL}${path}${query}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}` },
      body,
    },
    deadline,
  );
  const published = await jsonResponse(response);
  if (!response.ok) throw publicationError(response.status, published);
  const appId = requiredWireString(published.id, "id");
  const version = requiredWireString(published.version, "version");
  const activateRequested = options.activate !== false;
  if (response.status !== 202)
    return terminalPublicationResult(published, appId, version, activateRequested);

  const probing: PublishResult = {
    appId,
    version,
    state: "probing",
    activated: false,
    approvalPending: false,
  };

  const basePollIntervalMs = options.pollIntervalMs ?? 1000;
  let transientPollFailures = 0;
  while (Date.now() < deadline) {
    const backoffMs = Math.max(
      basePollIntervalMs,
      Math.min(basePollIntervalMs * 2 ** transientPollFailures, maxPollBackoffMs),
    );
    await wait(Math.min(backoffMs, Math.max(0, deadline - Date.now())));
    let statusResponse: Response;
    try {
      statusResponse = await fetchBeforePublicationDeadline(
        fetcher,
        `${apiURL}/api/v1/apps/${encodeURIComponent(appId)}?version=${encodeURIComponent(version)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${options.apiKey}` },
        },
        deadline,
      );
    } catch (error) {
      if (error instanceof PublicationTimeoutError) return probing;
      // Публикация уже принята (202), сетевой сбой poll-а её не отменяет:
      // продолжаем опрашивать с backoff до общего deadline.
      transientPollFailures += 1;
      continue;
    }
    const detail = await jsonResponse(statusResponse);
    if (statusResponse.status >= 500) {
      // Транзиентный сбой сервера (например 502) ретраится до deadline.
      transientPollFailures += 1;
      continue;
    }
    if (!statusResponse.ok) {
      // 4xx фатален сразу, но сохраняет durable identity принятой публикации.
      const failure = publicationDetail(statusResponse.status, detail);
      throw new PublicationFailedError(
        appId,
        version,
        failure,
        `публикация не выполнена: ${failure}`,
      );
    }
    transientPollFailures = 0;
    const publication =
      typeof detail.publication === "object" && detail.publication !== null
        ? (detail.publication as Record<string, unknown>)
        : undefined;
    if (
      publication &&
      publication.version === version &&
      (publication.state === "ready" || publication.state === "pruned")
    ) {
      return terminalPublicationResult(detail, appId, version, activateRequested);
    }
    if (
      publication &&
      publication.version === version &&
      publication.state === "pending" &&
      typeof publication.probe_error === "string" &&
      publication.probe_error
    ) {
      throw new PublicationFailedError(
        appId,
        version,
        publication.probe_error,
        `проверка публикации не пройдена: ${publication.probe_error}`,
      );
    }
  }
  return probing;
}

async function fetchBeforePublicationDeadline(
  fetcher: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  deadline: number,
): Promise<Response> {
  const remaining = Math.ceil(deadline - Date.now());
  if (remaining <= 0) throw publicationTimeoutError();
  const signal = AbortSignal.timeout(remaining);
  try {
    return await fetcher(input, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw publicationTimeoutError();
    throw error;
  }
}

class PublicationTimeoutError extends Error {}

function publicationTimeoutError(): PublicationTimeoutError {
  return new PublicationTimeoutError("публикация не завершилась за отведённое время");
}

// Терминальный отказ публикации ПОСЛЕ того, как версия принята платформой:
// appId и version уже durable, вызвавший агент может продолжить ремонт того же
// приложения через publish --app-id вместо создания дубликата.
export class PublicationFailedError extends Error {
  readonly appId: string;
  readonly version: string;
  readonly detail: string;

  constructor(appId: string, version: string, detail: string, message: string) {
    super(message);
    this.name = "PublicationFailedError";
    this.appId = appId;
    this.version = version;
    this.detail = detail;
  }
}

function terminalPublicationResult(
  payload: Record<string, any>,
  appId: string,
  version: string,
  activateRequested: boolean,
): PublishResult {
  const currentVersion = typeof payload.current_version === "string" ? payload.current_version : "";
  const publication =
    typeof payload.publication === "object" && payload.publication !== null
      ? (payload.publication as Record<string, unknown>)
      : {};
  const outcome = typeof publication.outcome === "string" ? publication.outcome : "";
  const activated =
    typeof payload.activated === "boolean"
      ? payload.activated
      : outcome
        ? outcome === "activated"
        : currentVersion === version;
  const publicState =
    typeof payload.public === "object" && payload.public !== null
      ? (payload.public as Record<string, unknown>)
      : {};
  const approvalPending =
    typeof payload.approval_pending === "boolean"
      ? payload.approval_pending
      : outcome
        ? outcome === "approval_pending"
        : activateRequested &&
          !activated &&
          payload.access === "public" &&
          (typeof payload.approved_version === "string"
            ? payload.approved_version !== version
            : publicState.approved_version !== version);
  const state =
    approvalPending || (!outcome && activateRequested && !activated) ? "ready_not_active" : "ready";
  return { appId, version, state, currentVersion, activated, approvalPending };
}

function closedDependencyPlugin(projectRoot: string): Plugin {
  const trustedPackageRoots = new Set<string>();
  return {
    name: "iskra-closed-dependencies",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.iskraClosedResolved === true) return;
        if (isAbsolute(args.path)) {
          if (args.kind === "entry-point") {
            const lexicalEntry = resolve(args.path);
            const realEntry = await realpath(lexicalEntry);
            if (
              isWithinOrEqual(projectRoot, realEntry) &&
              !entersNodeModules(projectRoot, realEntry)
            ) {
              return;
            }
            return {
              errors: [
                {
                  text: `entry point ${args.path} выходит за source root или входит в node_modules`,
                },
              ],
            };
          }
          return { errors: [{ text: `absolute import ${args.path} запрещён закрытой сборкой` }] };
        }
        if (args.path.startsWith(".")) {
          const resolveDir = args.resolveDir || dirname(args.importer);
          const lexicalPath = resolve(resolveDir, args.path);
          const importerPackageRoot = trustedPackageRoot(
            args.importer,
            projectRoot,
            trustedPackageRoots,
          );
          const allowedRoot = importerPackageRoot ?? projectRoot;
          if (!isWithinOrEqual(allowedRoot, lexicalPath)) {
            return { errors: [{ text: `импорт ${args.path} выходит вне проекта` }] };
          }
          if (!importerPackageRoot && entersNodeModules(projectRoot, lexicalPath)) {
            return {
              errors: [{ text: `импорт ${args.path} напрямую входит в node_modules` }],
            };
          }
          const resolved = await pluginBuild.resolve(args.path, {
            importer: args.importer,
            namespace: args.namespace,
            resolveDir,
            kind: args.kind,
            pluginData: { iskraClosedResolved: true },
          });
          if (resolved.errors.length > 0 || !resolved.path) return resolved;
          const realPath = await realpath(resolved.path);
          if (!isWithinOrEqual(allowedRoot, realPath)) {
            return { errors: [{ text: `импорт ${args.path} выходит вне проекта через ссылку` }] };
          }
          if (!importerPackageRoot && entersNodeModules(projectRoot, realPath)) {
            return {
              errors: [{ text: `импорт ${args.path} входит в node_modules через ссылку` }],
            };
          }
          return { ...resolved, path: realPath };
        }
        if (builtins.has(args.path)) return { path: args.path, external: true };
        const packageName = packageOf(args.path);
        const importerPackageRoot = trustedPackageRoot(
          args.importer,
          projectRoot,
          trustedPackageRoots,
        );
        if (!closedPackages.has(packageName) && !importerPackageRoot) {
          return {
            errors: [{ text: `импорт ${args.path} не входит в закрытый набор зависимостей Искры` }],
          };
        }
        const resolved = await pluginBuild.resolve(args.path, {
          resolveDir: importerPackageRoot ? dirname(args.importer) : sdkRoot,
          kind: args.kind,
          pluginData: { iskraClosedResolved: true },
        });
        if (resolved.errors.length > 0 || !resolved.path || !isAbsolute(resolved.path))
          return resolved;
        const packageRoot = await resolvedPackageRoot(resolved.path, packageName);
        if (!packageRoot) {
          return {
            errors: [{ text: `не удалось подтвердить корень зависимости ${packageName}` }],
          };
        }
        trustedPackageRoots.add(packageRoot);
        return resolved;
      });
    },
  };
}

function isWithinOrEqual(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function entersNodeModules(projectRoot: string, path: string): boolean {
  const rel = relative(projectRoot, path);
  return rel.split(sep).includes("node_modules");
}

function rejectNativeModules(): Plugin {
  return {
    name: "iskra-no-native-modules",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /\.node$/ }, (args) => ({
        errors: [{ text: `нативный модуль ${args.path} не поддерживается Apps runtime` }],
      }));
    },
  };
}

function packageOf(specifier: string): string {
  if (!specifier.startsWith("@")) return specifier.split("/")[0] ?? specifier;
  return specifier.split("/").slice(0, 2).join("/");
}

function trustedPackageRoot(
  importer: string,
  projectRoot: string,
  packageRoots: ReadonlySet<string>,
): string | undefined {
  let matched: string | undefined;
  for (const root of packageRoots) {
    if (isWithinOrEqual(root, importer) && (!matched || root.length > matched.length))
      matched = root;
  }
  if (!matched) return undefined;
  // В установленном SDK trusted package root законно лежит в project/node_modules.
  // Но project, физически вложенный в repository SDK, не наследует доверие
  // более широкого родительского package root.
  if (isWithinOrEqual(projectRoot, importer) && !isWithinOrEqual(projectRoot, matched)) {
    return undefined;
  }
  return matched;
}

async function resolvedPackageRoot(
  resolvedPath: string,
  packageName: string,
): Promise<string | undefined> {
  let current = dirname(resolvedPath);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === packageName) return await realpath(current);
    } catch {
      // Продолжаем до первого package.json с точным именем зависимости.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function checkBundleFiles(root: string): Promise<void> {
  parseManifest(JSON.parse(await readFile(join(root, "app.json"), "utf8")));
  if (!(await stat(join(root, "server.js"))).isFile())
    throw new Error("bundle не содержит server.js");
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`bundle содержит неподдерживаемый файл ${path}`);
    }
  }
  await walk(root);
  return files.sort((left, right) =>
    relative(root, left).localeCompare(relative(root, right), "en"),
  );
}

async function bundleBlob(bundle: Blob | Uint8Array | string): Promise<Blob> {
  if (bundle instanceof Blob) return bundle;
  if (typeof bundle === "string")
    return new Blob([new Uint8Array(await readFile(bundle))], { type: "application/zip" });
  return new Blob([bundle as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

async function jsonResponse(response: Response): Promise<Record<string, any>> {
  return (await response.json().catch(() => ({}))) as Record<string, any>;
}

function publicationError(status: number, payload: Record<string, any>): Error {
  return new Error(`публикация не выполнена: ${publicationDetail(status, payload)}`);
}

function publicationDetail(status: number, payload: Record<string, any>): string {
  return typeof payload.detail === "string" && payload.detail
    ? payload.detail
    : typeof payload.code === "string" && payload.code
      ? payload.code
      : `Искра ответила HTTP ${status}`;
}

function requiredWireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`ответ публикации не содержит ${name}`);
  return value;
}

function assertWithin(root: string, child: string, label: string): void {
  const rel = relative(root, child);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`${label} обязан быть отдельным путём внутри проекта`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

// scaffoldServer — src/server.ts нового приложения. name — имя из манифеста: оно
// же запасное название экрана, пока запрос идёт мимо роутера (проба узла,
// локальный запуск).
const scaffoldServer = (
  name: string,
  style: AppStyle,
): string => `import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  APP_CSP,
  APP_STYLESHEET_PATH,
  appBasePath,
  appPage,
  appStylesheetResponse,
  appTitle,
} from "@iskra/apps";

// strict: false — обязательное условие публикации: узел проверяет кандидата
// запросом в корень приложения СО слэшем ("/\${slug}/"), и роутер потом водит
// туда же зрителей. Hono по умолчанию считает "/\${slug}" и "/\${slug}/"
// разными путями, поэтому строгий роутер отвечает пробе 404, и версия не
// публикуется.
const app = new Hono({ strict: false });
const ui = new Hono();

// Политика содержимого нужна каждому ответу экрана, поэтому middleware стоит
// первым: зарегистрированный после маршрута, к нему Hono уже не применится.
ui.use("*", async (context, next) => {
  await next();
  context.header("Content-Security-Policy", APP_CSP);
  context.header("X-Content-Type-Options", "nosniff");
});

app.get("/healthz", (context) => context.json({ ok: true }));

// Общий стиль приложений едет внутри @iskra/apps и отдаётся своим маршрутом:
// встроенный <style> политика содержимого запрещает, внешний источник — тоже.
ui.get(\`/\${APP_STYLESHEET_PATH}\`, (context) => appStylesheetResponse(context.req.raw));

// Название экрана приходит от роутера заголовком: владелец правит его на
// платформе, и оно доезжает до зрителей без пересборки. Запасное значение —
// имя из app.json: проба узла и локальный запуск идут мимо роутера.
ui.get("/", (context) =>
  context.html(
    appPage({
      title: appTitle(context.req.raw, ${JSON.stringify(name)}),
      request: context.req.raw,${style === "iskra" ? "" : `\n      style: ${JSON.stringify(style)},`}
      body: \`<section class="card card--pad"><p class="hint">Замени этот экран своим.</p></section>\`,
    }),
  ),
);

app.route(appBasePath(), ui);

serve({ fetch: app.fetch, port: 8080 });
`;
