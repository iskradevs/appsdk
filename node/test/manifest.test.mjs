import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sdk = import("../dist/manifest.js");

test("SDK хранит точную schema платформы", async () => {
  const platform = await readFile(new URL("../../manifest/schema.json", import.meta.url));
  const generated = await readFile(new URL("../schema.json", import.meta.url)).catch(() => Buffer.alloc(0));
  assert.deepEqual(generated, platform);
});

test("SDK и Go одинаково классифицируют manifest golden", async () => {
  const { validateManifest } = await sdk;
  const cases = JSON.parse(await readFile(new URL("../../manifest/testdata/parity.json", import.meta.url), "utf8"));
  for (const fixture of cases) {
    assert.equal(validateManifest(fixture.manifest).ok, fixture.valid, fixture.name);
  }
});
