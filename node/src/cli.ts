#!/usr/bin/env node
import { resolve } from "node:path";

import {
  AppAPIError,
  type AppAPIOptions,
  type AppAccess,
  buildApp,
  checkApp,
  getAppStatus,
  packProject,
  PublicationFailedError,
  PublicationUnknownError,
  publishApp,
  scaffoldApp,
  updateAppAccess,
} from "./cli-core.js";
import { packSourceArchive } from "./source-archive.js";
import { APP_LAYOUTS, APP_STYLES } from "./starter.js";

const INIT_USAGE = `iskra-app init --name <slug> [--layout ${APP_LAYOUTS.join("|")}] [--style ${APP_STYLES.join("|")}]`;

interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "init": {
      const parsed = parseArgs(command, args, ["--path", "--name", "--layout", "--style"], []);
      const name = parsed.values.get("--name");
      if (!name) throw new Error(`использование: ${INIT_USAGE}`);
      const layout = parsed.values.get("--layout");
      const style = parsed.values.get("--style");
      await scaffoldApp(pathOf(parsed), {
        name,
        // Пустое значение передаётся как есть и отклоняется scaffoldApp:
        // --layout "" не должен молча дать минимальный каркас.
        ...(layout !== undefined ? { layout } : {}),
        ...(style !== undefined ? { style } : {}),
      });
      break;
    }
    case "check": {
      const parsed = parseArgs(command, args, ["--path"], []);
      await checkApp(pathOf(parsed));
      break;
    }
    case "build": {
      const parsed = parseArgs(command, args, ["--path"], ["--closed"]);
      await buildApp(pathOf(parsed), { closedDependencies: closedBuild(parsed) });
      break;
    }
    case "pack": {
      const parsed = parseArgs(command, args, ["--path", "--output"], ["--closed"]);
      const path = pathOf(parsed);
      await packProject(path, resolve(parsed.values.get("--output") ?? `${path}.zip`), {
        closedDependencies: closedBuild(parsed),
      });
      break;
    }
    case "source-pack": {
      const parsed = parseArgs(command, args, ["--path", "--output"], []);
      const path = pathOf(parsed);
      const output = await packSourceArchive(
        path,
        resolve(parsed.values.get("--output") ?? `${path}-source.zip`),
      );
      process.stdout.write(`${output}\n`);
      break;
    }
    case "publish": {
      const parsed = parseArgs(
        command,
        args,
        ["--path", "--api-url", "--output", "--app-id", "--bundle"],
        ["--closed", "--no-activate"],
      );
      const bundle = parsed.values.get("--bundle");
      if (bundle !== undefined) {
        const conflicts = ["--path", "--output"].filter((flag) => parsed.values.has(flag));
        if (parsed.switches.has("--closed")) conflicts.push("--closed");
        if (conflicts.length) throw new Error(`--bundle несовместим с ${conflicts.join(", ")}`);
        if (!bundle) throw new Error("--bundle требует путь ZIP");
      }
      const credentials = apiOptions(command, parsed);
      let output: string;
      if (bundle !== undefined) {
        output = resolve(bundle);
      } else {
        const path = pathOf(parsed);
        output = resolve(parsed.values.get("--output") ?? `${path}.zip`);
        await packProject(path, output, { closedDependencies: closedBuild(parsed) });
      }
      const appId = parsed.values.get("--app-id");
      const result = await publishApp(output, {
        ...credentials,
        ...(appId ? { appId } : {}),
        activate: !parsed.switches.has("--no-activate"),
      });
      writeJSON(result);
      break;
    }
    case "status": {
      const parsed = parseArgs(command, args, ["--app-id", "--version", "--api-url"], []);
      const appId = requiredAppId(parsed);
      const version = parsed.values.get("--version");
      if (!version) throw new Error("status требует --version VERSION");
      writeJSON(await getAppStatus(appId, version, apiOptions(command, parsed)));
      break;
    }
    case "access": {
      const parsed = parseArgs(command, args, ["--app-id", "--access", "--api-url"], []);
      const appId = requiredAppId(parsed);
      const access = parsed.values.get("--access");
      if (!["private", "org", "public"].includes(access ?? ""))
        throw new Error("access требует --access private|org|public");
      writeJSON(await updateAppAccess(appId, access as AppAccess, apiOptions(command, parsed)));
      break;
    }
    default:
      throw new Error(
        `использование: iskra-app init|check|build|pack|source-pack|publish|status|access [аргументы]\n  ${INIT_USAGE}`,
      );
  }
}

function apiOptions(command: string, parsed: ParsedArgs): AppAPIOptions {
  const apiUrl = parsed.values.get("--api-url") ?? process.env.ISKRA_API_URL;
  const apiKey = process.env.ISKRA_API_KEY;
  if (!apiUrl || !apiKey)
    throw new Error(`${command} требует --api-url/ISKRA_API_URL и ISKRA_API_KEY`);
  return { apiUrl, apiKey };
}

function requiredAppId(parsed: ParsedArgs): string {
  const appId = parsed.values.get("--app-id");
  if (!appId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId))
    throw new Error("--app-id требует UUID приложения");
  return appId;
}

function pathOf(parsed: ParsedArgs): string {
  return resolve(parsed.values.get("--path") ?? ".");
}

function closedBuild(parsed: ParsedArgs): boolean {
  return parsed.switches.has("--closed") || process.env.ISKRA_APPS_CLOSED_BUILD === "true";
}

// Неизвестный аргумент — ошибка, а не тихий no-op: опечатка вроде --appid не
// должна незаметно переключать publish на create-path, а --close — открывать
// сборку зависимостей.
function parseArgs(
  command: string,
  args: string[],
  valueFlags: readonly string[],
  switchFlags: readonly string[],
): ParsedArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (valueFlags.includes(token)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${token} требует значение`);
      values.set(token, value);
      index += 1;
      continue;
    }
    if (switchFlags.includes(token)) {
      switches.add(token);
      continue;
    }
    const known = [...valueFlags, ...switchFlags].join(", ");
    throw new Error(`неизвестный аргумент ${token} для ${command}; допустимо: ${known}`);
  }
  return { values, switches };
}

// Вывод ограничен DTO и безопасными полями ошибки. Даже отражённый сервером
// credential не должен попасть в stdout/stderr вызвавшего агента.
function safeOutput(value: unknown): unknown {
  if (typeof value === "string") {
    const key = process.env.ISKRA_API_KEY;
    const redacted = key ? value.replaceAll(key, "[redacted]") : value;
    return redacted.replace(/\bBearer\s+\S+/gi, "[redacted]");
  }
  if (Array.isArray(value)) return value.map(safeOutput);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(authorization|proxy-authorization|headers|request(?:_?options|Init)?|api[_-]?key|token|secret)$/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, safeOutput(item)]),
    );
  }
  return value;
}

function writeJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(safeOutput(value))}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof AppAPIError) {
    writeJSON({
      error:
        error instanceof PublicationFailedError
          ? "app_publication_failed"
          : error instanceof PublicationUnknownError
            ? "app_publication_unknown"
            : "app_api_error",
      app_id: error.appId,
      version: error.version,
      status: error.status,
      code: error.code,
      params: error.params,
      request_id: error.requestId,
      detail: error.detail,
    });
  }
  const message = error instanceof Error ? error.message : "команда не выполнена";
  // Одна строка без stack/cause или произвольного объекта транспортной ошибки.
  const summary = String(safeOutput(message)).replace(/[\r\n\x00-\x1f\x7f]+/g, " ");
  process.stderr.write(
    `iskra-app: ${summary.length > 500 ? `${summary.slice(0, 500)}…` : summary}\n`,
  );
  process.exitCode = 1;
});
