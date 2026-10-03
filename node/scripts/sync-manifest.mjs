import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "json-schema-to-typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "../manifest/schema.json");
const schemaPath = resolve(root, "schema.json");
const generatedTypePath = resolve(root, "src/manifest.generated.ts");
const generatedSchemaPath = resolve(root, "src/schema.generated.ts");
const check = process.argv.includes("--check");

const source = await readFile(sourcePath, "utf8");
const schema = JSON.parse(source);
const generatedTypes = await compile({ ...schema, title: "AppManifest" }, "AppManifest", {
  bannerComment: "/* Сгенерировано из services/apps/manifest/schema.json. Не редактировать вручную. */",
  additionalProperties: false,
  style: { singleQuote: false, semi: true },
});
const generatedSchema = `/* Сгенерировано из services/apps/manifest/schema.json. Не редактировать вручную. */\nexport const manifestSchema = ${JSON.stringify(schema, null, 2)} as const;\n`;

async function sync(path, expected) {
  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== expected) {
      throw new Error(`${path} не синхронизирован с ${sourcePath}`);
    }
    return;
  }
  await writeFile(path, expected);
}

await sync(schemaPath, source);
await sync(generatedTypePath, generatedTypes);
await sync(generatedSchemaPath, generatedSchema);
