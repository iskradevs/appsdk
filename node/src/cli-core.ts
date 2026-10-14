import { builtinModules } from "node:module";
import { createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";
import { ZipFile } from "yazl";
import { z, type ZodType } from "zod";

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
export type PackOptions = Omit<BuildOptions, "outDir">;
export interface AppAPIOptions {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}
export interface PublishOptions extends AppAPIOptions {
  readonly appId?: string;
  readonly activate?: boolean;
  readonly pollIntervalMs?: number;
}
export interface PublishResult {
  readonly appId: string;
  readonly version: string;
  readonly state: "ready" | "ready_not_active" | "probing";
  readonly currentVersion?: string;
  readonly activated: boolean;
  readonly viewerBaseUrl?: string;
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
  // Пример несёт свой манифест; новый минимальный проект начинает с 0.1.0.
  const source = exampleDir(layout);
  const manifest = {
    ...(JSON.parse(await readFile(join(source, "app.json"), "utf8")) as object),
    name: options.name,
    ...(layout === undefined ? { version: "0.1.0" } : {}),
  };
  parseManifest(manifest);
  await writeFile(join(target, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  await copyExampleSources(source, target, options.name, style);
}

// npm-пакет публикует examples рядом с dist; init использует те же примеры,
// которые автор может скачать и собрать самостоятельно.
const exampleDir = (layout: AppLayout | undefined): string =>
  fileURLToPath(
    new URL(`../examples/${layout ? `layouts/${layout}` : "minimal"}`, import.meta.url),
  );

// Копируются все авторские src/** и static/** с исключительной записью;
// имя и стиль подставляются только в модуль параметров.
// См. docs/plans/2026-10-03-apps-authoring-workspace-design.md — «Авторская структура».
async function copyExampleSources(
  source: string,
  target: string,
  name: string,
  style: AppStyle,
): Promise<void> {
  const config = await readFile(join(source, "src/config.ts"), "utf8");
  const patched = replaceOnce(
    replaceOnce(
      config,
      /^export const APP_NAME = "[^"]*";$/m,
      `export const APP_NAME = ${JSON.stringify(name)};`,
    ),
    /^export const APP_STYLE: AppStyle = "[^"]*";$/m,
    `export const APP_STYLE: AppStyle = ${JSON.stringify(style)};`,
  );
  // Корневые каталоги уже созданы; каждый существующий файл сохраняется.
  for (const tree of ["src", "static"]) {
    const sourceDir = join(source, tree);
    if (!(await exists(sourceDir))) continue;
    for (const entry of await readdir(sourceDir)) {
      if (tree === "src" && entry === "config.ts") continue;
      await cp(join(sourceDir, entry), join(target, tree, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
  }
  await writeFile(join(target, "src/config.ts"), patched, { flag: "wx" });
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
  await bundleApp(root, outDir, options);
  return outDir;
}

async function bundleApp(root: string, outDir: string, options: PackOptions): Promise<void> {
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
}

// Автоматическая упаковка владеет временным staging: авторский каталог остаётся
// источником правды, а прежний ручной build удаляется после готового ZIP.
export async function packProject(
  projectDir: string,
  outputPath: string,
  options: PackOptions = {},
): Promise<void> {
  const root = resolve(projectDir);
  await checkApp(root);
  const legacy = join(root, ".iskra-build");
  const output = resolve(outputPath);
  await assertArchiveOutsideLegacy(legacy, output);
  const manifest = parseManifest(JSON.parse(await readFile(join(root, "app.json"), "utf8")));
  const retireLegacy = await checkLegacyBuild(legacy, manifest.name);
  const staging = await mkdtemp(join(tmpdir(), "iskra-app-pack-"));
  try {
    await bundleApp(root, staging, options);
    await packApp(staging, output);
    if (retireLegacy) {
      const currentLegacy = await checkLegacyBuild(legacy, manifest.name);
      if (
        !currentLegacy ||
        currentLegacy.device !== retireLegacy.device ||
        currentLegacy.inode !== retireLegacy.inode
      ) {
        throw new Error(
          ".iskra-build изменился во время сборки; проверь и перемести каталог перед упаковкой",
        );
      }
      await rm(legacy, { recursive: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function assertArchiveOutsideLegacy(legacy: string, output: string): Promise<void> {
  if (
    isWithinOrEqual(legacy, output) ||
    isWithinOrEqual(await resolvePotentialPath(legacy), await resolvePotentialPath(output))
  ) {
    throw new Error("output ZIP обязан находиться вне .iskra-build; выбери другой --output");
  }
}

// realpath ближайшего существующего родителя проверяет также пути к ещё
// не созданному архиву. Отдельно раскрываем ссылку на отсутствующий файл.
async function resolvePotentialPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  const info = await lstat(path).catch((error: unknown) => {
    if (!isMissingPath(error)) throw error;
    return undefined;
  });
  if (info?.isSymbolicLink()) {
    return resolvePotentialPath(resolve(dirname(path), await readlink(path)));
  }
  const parent = dirname(path);
  if (parent === path) throw new Error(`не удалось разрешить путь ${path}`);
  return join(await resolvePotentialPath(parent), basename(path));
}

async function checkLegacyBuild(
  legacy: string,
  appName: string,
): Promise<{ device: number; inode: number } | undefined> {
  const info = await lstat(legacy).catch((error: unknown) => {
    if (!isMissingPath(error)) throw error;
    return undefined;
  });
  if (!info) return undefined;
  try {
    if (!info.isDirectory()) throw new Error("ожидался обычный каталог");
    for (const required of ["app.json", "server.js"]) {
      if (!(await lstat(join(legacy, required))).isFile())
        throw new Error(`${required} обязан быть обычным файлом`);
    }
    for (const name of await readdir(legacy)) {
      if (name === "app.json" || name === "server.js") continue;
      if (name !== "static") throw new Error(`неизвестный файл ${name}`);
      await checkLegacyStatic(join(legacy, name));
    }
    const manifest = parseManifest(JSON.parse(await readFile(join(legacy, "app.json"), "utf8")));
    if (manifest.name !== appName) throw new Error("имя приложения отличается от авторского");
    return { device: info.dev, inode: info.ino };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `.iskra-build не распознан как прежний результат сборки: ${reason}; проверь и перемести ${legacy} перед упаковкой`,
      { cause: error },
    );
  }
}

async function checkLegacyStatic(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error(`${path} обязан быть обычным каталогом`);
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const info = await lstat(child);
    if (info.isDirectory()) await checkLegacyStatic(child);
    else if (!info.isFile()) throw new Error(`${child} обязан быть обычным файлом или каталогом`);
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
  const { fetcher, apiURL, deadline } = appAPIContext(options);
  const body = new FormData();
  body.set("bundle", await bundleBlob(bundle), "app.zip");
  const path = options.appId
    ? `/api/v1/apps/${encodeURIComponent(options.appId)}/versions`
    : "/api/v1/apps";
  const query = `?activate=${options.activate === false ? "false" : "true"}`;
  const knownIdentity = options.appId ? { appId: options.appId } : {};
  let response: Response;
  try {
    response = await fetchBeforePublicationDeadline(
      fetcher,
      `${apiURL}${path}${query}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}` },
        body,
      },
      deadline,
    );
  } catch (error) {
    // Ответ потерян: POST мог быть принят. Повтор выполняет вызывающий после
    // проверки состояния; CLI сохраняет неизвестный исход без нового запроса.
    const detail =
      error instanceof PublicationTimeoutError
        ? error.message
        : "ответ публикации не получен; проверь состояние перед повторной отправкой";
    throw new PublicationUnknownError(detail, knownIdentity);
  }
  const published = await jsonResponse(response, deadline);
  const metadata = responseMetadata(response, published, knownIdentity);
  if (!response.ok) throw new AppAPIError(publicationDetail(response.status, published), metadata);
  const appId = nonemptyWireString(published?.id);
  const version = nonemptyWireString(published?.version);
  if (
    !appId ||
    !version ||
    !["probing", "ready", "ready_not_active"].includes(String(published?.state))
  ) {
    throw new PublicationUnknownError(
      "ответ публикации имеет неверный формат; проверь состояние перед повторной отправкой",
      {
        ...metadata,
        code: "invalid_api_response",
        ...(appId ? { appId } : {}),
        ...(version ? { version } : {}),
      },
    );
  }
  const activateRequested = options.activate !== false;
  if (response.status !== 202)
    return terminalPublicationResult(published!, appId, version, activateRequested);

  let viewerBaseUrl = nonemptyWireString(published?.viewer_base_url);
  const probingResult = (): PublishResult => ({
    appId,
    version,
    state: "probing",
    activated: false,
    ...(viewerBaseUrl ? { viewerBaseUrl } : {}),
  });
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
        { method: "GET", headers: { authorization: `Bearer ${options.apiKey}` } },
        deadline,
      );
    } catch (error) {
      if (error instanceof PublicationTimeoutError) return probingResult();
      // После 202 сетевой сбой не отменяет принятую версию.
      transientPollFailures += 1;
      continue;
    }
    const detail = await jsonResponse(statusResponse, deadline);
    if (statusResponse.status >= 500) {
      transientPollFailures += 1;
      continue;
    }
    const statusMetadata = responseMetadata(statusResponse, detail, { appId, version });
    if (!statusResponse.ok) {
      const failure = publicationDetail(statusResponse.status, detail);
      throw new PublicationFailedError(
        appId,
        version,
        failure,
        `публикация не выполнена: ${failure}`,
        statusMetadata,
      );
    }
    if (!detail) {
      if (Date.now() >= deadline) return probingResult();
      throw new PublicationFailedError(
        appId,
        version,
        "ответ статуса имеет неверный формат",
        "ответ статуса имеет неверный формат",
        { ...statusMetadata, code: "invalid_api_response" },
      );
    }
    viewerBaseUrl = nonemptyWireString(detail.viewer_base_url) ?? viewerBaseUrl;
    transientPollFailures = 0;
    const publication = objectRecord(detail.publication);
    if (
      publication?.version === version &&
      (publication.state === "ready" || publication.state === "pruned")
    ) {
      return terminalPublicationResult(detail, appId, version, activateRequested, viewerBaseUrl);
    }
    if (
      publication?.version === version &&
      publication.state === "pending" &&
      typeof publication.probe_error === "string" &&
      publication.probe_error
    ) {
      throw new PublicationFailedError(
        appId,
        version,
        publication.probe_error,
        `проверка публикации не пройдена: ${publication.probe_error}`,
        statusMetadata,
      );
    }
  }
  return probingResult();
}

const accessResponseSchema = z.object({
  id: z.string(),
  access: z.enum(["private", "org", "public"]),
  current_version: z.string().optional(),
});

const statusResponseSchema = accessResponseSchema.extend({
  slug: z.string(),
  title: z.string(),
  status: z.enum(["draft", "active", "stopped"]),
  viewer_base_url: z.string().optional(),
  publication: z.object({
    version: z.string(),
    state: z.string(),
    activate_on_ready: z.boolean(),
    probe_error: z.string().optional(),
    outcome: z.enum(["activated", "not_requested", "not_activated"]).optional(),
  }),
});

// Однократное чтение точной версии возвращает проверенный DTO без преобразования.
export async function getAppStatus(
  appId: string,
  version: string,
  options: AppAPIOptions,
): Promise<Record<string, unknown>> {
  return appJSONRequest(
    `/api/v1/apps/${encodeURIComponent(appId)}?version=${encodeURIComponent(version)}`,
    { method: "GET" },
    options,
    { appId, version },
    statusResponseSchema,
  );
}

export type AppAccess = "private" | "org" | "public";

export async function updateAppAccess(
  appId: string,
  access: AppAccess,
  options: AppAPIOptions,
): Promise<Record<string, unknown>> {
  return appJSONRequest(
    `/api/v1/apps/${encodeURIComponent(appId)}/access`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access }),
    },
    options,
    { appId },
    accessResponseSchema,
  );
}

async function appJSONRequest(
  path: string,
  init: RequestInit,
  options: AppAPIOptions,
  identity: AppAPIErrorMetadata,
  responseSchema: ZodType,
): Promise<Record<string, unknown>> {
  const { fetcher, apiURL, deadline } = appAPIContext(options);
  let response: Response;
  try {
    response = await fetchBeforePublicationDeadline(
      fetcher,
      `${apiURL}${path}`,
      {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${options.apiKey}` },
      },
      deadline,
    );
  } catch (error) {
    const detail =
      error instanceof PublicationTimeoutError
        ? "ответ API не получен за отведённое время"
        : "ответ API не получен";
    throw new AppAPIError(detail, identity);
  }
  const payload = await jsonResponse(response, deadline);
  const metadata = responseMetadata(response, payload, identity);
  if (!response.ok) throw new AppAPIError(publicationDetail(response.status, payload), metadata);
  if (!payload || !responseSchema.safeParse(payload).success)
    throw new AppAPIError("ответ API имеет неверный формат", {
      ...metadata,
      code: "invalid_api_response",
    });
  return payload;
}

function appAPIContext(options: AppAPIOptions): {
  fetcher: typeof globalThis.fetch;
  apiURL: string;
  deadline: number;
} {
  if (!options.apiKey.startsWith("isk_") || !options.apiUrl)
    throw new Error("apiUrl и API key формата isk_ обязательны");
  const timeoutMs = options.timeoutMs ?? defaultPublicationTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("timeoutMs обязан быть положительным конечным числом");
  return {
    fetcher: options.fetch ?? globalThis.fetch,
    apiURL: options.apiUrl.replace(/\/+$/, ""),
    deadline: Date.now() + timeoutMs,
  };
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

export interface AppAPIErrorMetadata {
  readonly status?: number;
  readonly code?: string;
  readonly params?: Record<string, unknown>;
  readonly requestId?: string;
  readonly appId?: string;
  readonly version?: string;
}

export class AppAPIError extends Error implements AppAPIErrorMetadata {
  readonly detail: string;
  readonly status?: number;
  readonly code?: string;
  readonly params?: Record<string, unknown>;
  readonly requestId?: string;
  readonly appId?: string;
  readonly version?: string;

  constructor(detail: string, metadata: AppAPIErrorMetadata = {}, message = detail) {
    super(message);
    this.name = "AppAPIError";
    this.detail = detail;
    Object.assign(this, metadata);
  }
}

export class PublicationUnknownError extends AppAPIError {
  constructor(detail: string, metadata: AppAPIErrorMetadata = {}) {
    super(detail, metadata);
    this.name = "PublicationUnknownError";
  }
}

// Терминальный отказ после приёма версии сохраняет durable identity для ремонта.
export class PublicationFailedError extends AppAPIError {
  declare readonly appId: string;
  declare readonly version: string;

  constructor(
    appId: string,
    version: string,
    detail: string,
    message: string,
    metadata: AppAPIErrorMetadata = {},
  ) {
    super(detail, { ...metadata, appId, version }, message);
    this.name = "PublicationFailedError";
  }
}

function terminalPublicationResult(
  payload: Record<string, unknown>,
  appId: string,
  version: string,
  activateRequested: boolean,
  acceptedViewerBaseUrl?: string,
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
  const state =
    payload.state === "ready_not_active" ||
    outcome === "not_activated" ||
    (!outcome && payload.state !== "ready" && activateRequested && !activated)
      ? "ready_not_active"
      : "ready";
  const viewerBaseUrl = nonemptyWireString(payload.viewer_base_url) ?? acceptedViewerBaseUrl;
  return {
    appId,
    version,
    state,
    currentVersion,
    activated,
    ...(viewerBaseUrl ? { viewerBaseUrl } : {}),
  };
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

async function jsonResponse(
  response: Response,
  deadline: number,
): Promise<Record<string, unknown> | undefined> {
  // Deadline охватывает тело ответа; медленный/оборванный JSON не превращает
  // принятый POST в бессрочное ожидание и не выводится как сырой HTML/текст.
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response
        .json()
        .then(objectRecord)
        .catch(() => undefined),
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function responseMetadata(
  response: Response,
  payload: Record<string, unknown> | undefined,
  identity: AppAPIErrorMetadata,
): AppAPIErrorMetadata {
  const params = objectRecord(payload?.params);
  const code = nonemptyWireString(payload?.code);
  const requestId =
    nonemptyWireString(response.headers.get("x-request-id")) ??
    nonemptyWireString(payload?.request_id);
  const appId =
    identity.appId ??
    nonemptyWireString(payload?.app_id) ??
    nonemptyWireString(payload?.id) ??
    nonemptyWireString(params?.app_id);
  const version =
    identity.version ?? nonemptyWireString(payload?.version) ?? nonemptyWireString(params?.version);
  return {
    status: response.status,
    ...(code ? { code } : {}),
    ...(params ? { params } : {}),
    ...(requestId ? { requestId } : {}),
    ...(appId ? { appId } : {}),
    ...(version ? { version } : {}),
  };
}

function publicationDetail(status: number, payload: Record<string, unknown> | undefined): string {
  return (
    nonemptyWireString(payload?.detail) ??
    nonemptyWireString(payload?.code) ??
    `Искра ответила HTTP ${status}`
  );
}

function nonemptyWireString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
