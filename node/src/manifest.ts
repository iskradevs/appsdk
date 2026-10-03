import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";

import type { AppManifest } from "./manifest.generated.js";
import { manifestSchema } from "./schema.generated.js";

export type { AppManifest } from "./manifest.generated.js";

export interface ManifestValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const reservedSlugs = new Set([
  "www", "api", "apps", "admin", "static", "assets", "auth", "login", "health", "iskra",
  "mail", "smtp", "imap", "mx", "ns1", "ns2", "autodiscover", "autoconfig", "router",
  "internal", "localhost", "metrics", "grafana", "cdn", "files", "s3", "minio", "test",
  "dev", "stage", "staging", "prod",
]);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = formatsModule as unknown as FormatsPlugin;
addFormats(ajv);
const validateSchema = ajv.compile<AppManifest>(manifestSchema);

function schemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"}: ${error.message ?? "невалидно"}`);
}

export function validateManifest(value: unknown): ManifestValidation {
  if (!validateSchema(value)) {
    return { ok: false, errors: schemaErrors(validateSchema.errors) };
  }

  const errors: string[] = [];
  if (value.name.startsWith("xn--") || (value.name.length >= 4 && value.name.slice(2, 4) === "--")) {
    errors.push("/name: IDN-форма запрещена");
  }
  if (reservedSlugs.has(value.name)) {
    errors.push("/name: slug зарезервирован платформой");
  }
  if (value.version.includes("..")) {
    errors.push('/version: подстрока ".." запрещена');
  }
  const slots = new Set<string>();
  for (const secret of value.secrets ?? []) {
    if (slots.has(secret.slot)) {
      errors.push(`/secrets: слот ${secret.slot} объявлен повторно`);
    }
    slots.add(secret.slot);
  }
  return { ok: errors.length === 0, errors };
}

export function parseManifest(value: unknown): AppManifest {
  const result = validateManifest(value);
  if (!result.ok) {
    throw new Error(`app.json невалиден: ${result.errors.join("; ")}`);
  }
  return value as AppManifest;
}
