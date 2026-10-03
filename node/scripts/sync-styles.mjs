import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "styles/app.css");
const generatedPath = resolve(root, "src/styles.generated.ts");
const check = process.argv.includes("--check");

// CSS едет строкой внутри модуля, а не файлом рядом с ним: tsc копирует в dist
// только .ts, а приложение собирается esbuild-ом из src — файл на диске до
// бандла не доехал бы. JSON.stringify берёт на себя экранирование: в CSS есть
// кавычки и обратные слэши, и шаблонная строка потребовала бы своих правил.
const source = await readFile(sourcePath, "utf8");
const generated = `/* Сгенерировано из services/apps/sdk/styles/app.css. Не редактировать вручную. */
export const appStylesheet = ${JSON.stringify(source)};
`;

if (check) {
  const current = await readFile(generatedPath, "utf8").catch(() => "");
  if (current !== generated) {
    throw new Error(`${generatedPath} не синхронизирован с ${sourcePath}`);
  }
} else {
  await writeFile(generatedPath, generated);
}
