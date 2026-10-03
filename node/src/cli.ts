#!/usr/bin/env node
import { resolve } from "node:path";

import {
  buildApp,
  checkApp,
  packApp,
  PublicationFailedError,
  publishApp,
  scaffoldApp,
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
      const buildDir = await buildApp(path, { closedDependencies: closedBuild(parsed) });
      await packApp(buildDir, resolve(parsed.values.get("--output") ?? `${path}.zip`));
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
        ["--path", "--api-url", "--output", "--app-id"],
        ["--closed", "--no-activate"],
      );
      const path = pathOf(parsed);
      const apiUrl = parsed.values.get("--api-url") ?? process.env.ISKRA_API_URL;
      const apiKey = process.env.ISKRA_API_KEY;
      if (!apiUrl || !apiKey)
        throw new Error("publish требует --api-url/ISKRA_API_URL и ISKRA_API_KEY");
      const output = resolve(parsed.values.get("--output") ?? `${path}.zip`);
      const buildDir = await buildApp(path, { closedDependencies: closedBuild(parsed) });
      await packApp(buildDir, output);
      const appId = parsed.values.get("--app-id");
      const result = await publishApp(output, {
        apiUrl,
        apiKey,
        ...(appId ? { appId } : {}),
        activate: !parsed.switches.has("--no-activate"),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      break;
    }
    default:
      throw new Error(
        `использование: iskra-app init|check|build|pack|source-pack|publish [--path DIR]\n  ${INIT_USAGE}`,
      );
  }
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

main().catch((error: unknown) => {
  if (error instanceof PublicationFailedError) {
    // Структурный вывод сохраняет durable identity: вызвавший агент продолжает
    // ремонт того же приложения через publish --app-id, не создавая дубликат.
    process.stdout.write(
      `${JSON.stringify({
        error: "app_publication_failed",
        app_id: error.appId,
        version: error.version,
        detail: error.detail,
      })}\n`,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`iskra-app: ${message}\n`);
  process.exitCode = 1;
});
