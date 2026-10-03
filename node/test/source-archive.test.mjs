import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  SOURCE_MAX_DIRECTORIES,
  SOURCE_MAX_ENTRY_BYTES,
  SOURCE_MAX_FILES,
  SOURCE_MAX_TOTAL_BYTES,
  compareSourceNames,
  packSourceArchive,
} from "../dist/source-archive.js";

const execFileAsync = promisify(execFile);

function zipEntryNames(bytes) {
  const names = [];
  for (let offset = 0; offset + 46 <= bytes.length;) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    names.push(
      bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
    );
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

async function createProject(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "app.json"), "{}\n");
  await writeFile(join(project, "src", "server.ts"), "export {};\n");
  return { root, project, output: join(root, "source.zip") };
}

async function writeSparse(path, size) {
  const file = await open(path, "w");
  try {
    await file.truncate(size);
  } finally {
    await file.close();
  }
}

async function createMany(count, create) {
  const batchSize = 100;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    await Promise.all(
      Array.from({ length: end - start }, (_, index) => create(start + index)),
    );
  }
}

async function assertAtomicFailure(project, output, pattern) {
  const previous = Buffer.from("previous-good-archive");
  await writeFile(output, previous);
  await assert.rejects(() => packSourceArchive(project, output), pattern);
  assert.deepEqual(await readFile(output), previous);
  const temporaryPrefix = `${basename(output)}.tmp-`;
  const residue = (await readdir(dirname(output))).filter((name) =>
    name.startsWith(temporaryPrefix),
  );
  assert.deepEqual(residue, []);
}

function waitForTemporary(directory, outputName) {
  const prefix = `${outputName}.tmp-`;
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, { persistent: false });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`temporary archive ${prefix} was not created`));
    }, 5_000);
    watcher.once("error", (error) => {
      clearTimeout(timer);
      watcher.close();
      reject(error);
    });
    watcher.on("change", (_event, filename) => {
      const name = filename?.toString();
      if (!name?.startsWith(prefix)) return;
      clearTimeout(timer);
      watcher.close();
      resolve(join(directory, name));
    });
  });
}

async function assertNoTemporary(directory, outputName) {
  const prefix = `${outputName}.tmp-`;
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith(prefix)),
    [],
  );
}

test("source archive exports the exact safety limits", () => {
  assert.equal(SOURCE_MAX_FILES, 2_000);
  assert.equal(SOURCE_MAX_DIRECTORIES, 2_000);
  assert.equal(SOURCE_MAX_ENTRY_BYTES, 64 * 1024 * 1024);
  assert.equal(SOURCE_MAX_TOTAL_BYTES, 256 * 1024 * 1024);
});

test("source archive is deterministic and contains only the authoring allowlist", async (t) => {
  const { root, project } = await createProject(t, "iskra-app-source-");
  await mkdir(join(project, "static"), { recursive: true });
  await mkdir(join(project, "src", "nested", ".env.generated"), {
    recursive: true,
  });
  await mkdir(join(project, "src", "nested", ".iskra-build"), {
    recursive: true,
  });
  await mkdir(join(project, "static", "nested", "node_modules", "x"), {
    recursive: true,
  });
  await writeFile(join(project, "static", "index.html"), "ok");
  await writeFile(
    join(project, "README.md"),
    "not part of the author source archive",
  );
  await writeFile(join(project, "src", ".env.production"), "SECRET=never");
  await writeFile(
    join(project, "src", "nested", ".env.generated", "secret"),
    "never",
  );
  await writeFile(
    join(project, "src", "nested", ".iskra-build", "server.js"),
    "built",
  );
  await writeFile(
    join(project, "static", "nested", "node_modules", "x", "index.js"),
    "dependency",
  );

  const first = join(root, "first.zip");
  const second = join(root, "second.zip");
  await packSourceArchive(project, first);
  await packSourceArchive(project, second);

  assert.deepEqual(await readFile(first), await readFile(second));
  assert.deepEqual(zipEntryNames(await readFile(first)), [
    "app.json",
    "src/server.ts",
    "static/index.html",
  ]);
});

test("source archive bytes do not depend on the process timezone", async (t) => {
  const { root, project } = await createProject(
    t,
    "iskra-app-source-timezone-",
  );
  const cli = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "dist",
    "cli.js",
  );
  const utc = join(root, "utc.zip");
  const losAngeles = join(root, "los-angeles.zip");

  await execFileAsync(
    process.execPath,
    [cli, "source-pack", "--path", project, "--output", utc],
    { env: { ...process.env, TZ: "UTC" } },
  );
  await execFileAsync(
    process.execPath,
    [cli, "source-pack", "--path", project, "--output", losAngeles],
    { env: { ...process.env, TZ: "America/Los_Angeles" } },
  );

  assert.deepEqual(await readFile(utc), await readFile(losAngeles));
});

test("source archive ordering breaks locale-equivalent ties by code units", () => {
  const decomposed = "src/e\u0301.ts";
  const composed = "src/é.ts";

  assert.equal(decomposed.localeCompare(composed, "en"), 0);
  assert.deepEqual([composed, decomposed].sort(compareSourceNames), [
    decomposed,
    composed,
  ]);
  assert.equal(Math.sign(compareSourceNames(decomposed, composed)), -1);
  assert.equal(Math.sign(compareSourceNames(composed, decomposed)), 1);
});

test("source archive rejects backslashes in POSIX path segments", async (t) => {
  if (sep !== "/") {
    t.skip("POSIX filename semantics are required");
    return;
  }
  const { project, output } = await createProject(
    t,
    "iskra-app-source-backslash-",
  );
  await mkdir(join(project, "src", "a"));
  await writeFile(join(project, "src", "a", "b.ts"), "nested");
  await writeFile(join(project, "src", "a\\b.ts"), "backslash");

  await assertAtomicFailure(project, output, /backslash/i);
});

test("source archive rejects symlinks in allowed roots", async (t) => {
  const { root, project, output } = await createProject(
    t,
    "iskra-app-source-link-",
  );
  await writeFile(join(root, "outside.ts"), "secret");
  await symlink(join(root, "outside.ts"), join(project, "src", "linked.ts"));

  await assertAtomicFailure(project, output, /symlink/i);
});

test("source archive rejects a source atomically swapped after preflight", async (t) => {
  const { root, project, output } = await createProject(
    t,
    "iskra-app-source-swap-",
  );
  await writeSparse(
    join(project, "src", "a-large.bin"),
    SOURCE_MAX_ENTRY_BYTES,
  );
  const source = join(project, "src", "z.ts");
  const replacement = join(root, "z-replacement.ts");
  const outside = join(root, "outside.ts");
  await writeFile(source, "safe");
  await writeFile(outside, "LEAK");
  await symlink(outside, replacement);
  const previous = Buffer.from("previous-good-archive");
  await writeFile(output, previous);

  const temporarySeen = waitForTemporary(root, basename(output));
  const packing = packSourceArchive(project, output);
  const rejection = assert.rejects(packing, /source entry changed/i);
  void rejection.catch(() => undefined);
  await temporarySeen;
  await rename(replacement, source);
  await rejection;

  assert.deepEqual(await readFile(output), previous);
  await assertNoTemporary(root, basename(output));
});

test("source archive rejects an equal-size in-place source rewrite", async (t) => {
  const { project, output } = await createProject(
    t,
    "iskra-app-source-in-place-",
  );
  await writeSparse(
    join(project, "src", "a-large.bin"),
    SOURCE_MAX_ENTRY_BYTES,
  );
  const source = join(project, "src", "z.ts");
  const initial = Buffer.from("SAFE");
  const replacement = Buffer.from("LEAK");
  await writeFile(source, initial);
  const identity = await lstat(source, { bigint: true });
  const mutationHandle = await open(source, "r+");
  const fileHandlePrototype = Object.getPrototypeOf(mutationHandle);
  const originalStat = fileHandlePrototype.stat;
  const originalRead = fileHandlePrototype.read;
  let snapshotReader = null;
  let mutated = false;

  fileHandlePrototype.stat = async function (...args) {
    const info = await Reflect.apply(originalStat, this, args);
    if (info.dev === identity.dev && info.ino === identity.ino) {
      info.ctimeNs = identity.ctimeNs;
      info.mtimeNs = identity.mtimeNs;
    }
    return info;
  };
  fileHandlePrototype.read = async function (...args) {
    const info = await Reflect.apply(originalStat, this, [{ bigint: true }]);
    if (
      info.dev === identity.dev &&
      info.ino === identity.ino &&
      snapshotReader === null
    ) {
      snapshotReader = this;
    } else if (
      !mutated &&
      info.dev === identity.dev &&
      info.ino === identity.ino &&
      this !== snapshotReader
    ) {
      mutated = true;
      const result = await mutationHandle.write(
        replacement,
        0,
        replacement.length,
        0,
      );
      assert.equal(result.bytesWritten, replacement.length);
      await mutationHandle.sync();
    }
    return Reflect.apply(originalRead, this, args);
  };

  try {
    await assertAtomicFailure(project, output, /source entry changed/i);
  } finally {
    fileHandlePrototype.stat = originalStat;
    fileHandlePrototype.read = originalRead;
    await mutationHandle.close();
  }

  assert.equal(mutated, true);
  const after = await lstat(source, { bigint: true });
  assert.equal(after.dev, identity.dev);
  assert.equal(after.ino, identity.ino);
  assert.equal(after.size, identity.size);
  assert.deepEqual(await readFile(source), replacement);
});

test("source archive reads at most the validated size plus one growth probe", async (t) => {
  const { project, output } = await createProject(
    t,
    "iskra-app-source-growth-",
  );
  const source = join(project, "src", "growing.bin");
  const initial = Buffer.from("validated");
  await writeFile(source, initial);
  const identity = await lstat(source, { bigint: true });
  const prototypeHandle = await open(source, "r");
  const fileHandlePrototype = Object.getPrototypeOf(prototypeHandle);
  await prototypeHandle.close();
  const originalStat = fileHandlePrototype.stat;
  const originalRead = fileHandlePrototype.read;
  const trackedDescriptors = new Set();
  let bytesRead = 0;
  let grewAfterStat = false;

  fileHandlePrototype.stat = async function (...args) {
    const info = await Reflect.apply(originalStat, this, args);
    if (
      !grewAfterStat &&
      info.dev === identity.dev &&
      info.ino === identity.ino
    ) {
      trackedDescriptors.add(this.fd);
      grewAfterStat = true;
      await appendFile(source, Buffer.alloc(64 * 1024, 1));
    }
    return info;
  };
  fileHandlePrototype.read = async function (...args) {
    const result = await Reflect.apply(originalRead, this, args);
    if (trackedDescriptors.has(this.fd)) bytesRead += result.bytesRead;
    return result;
  };

  try {
    await assertAtomicFailure(
      project,
      output,
      /source entry changed|unexpected number of bytes/i,
    );
  } finally {
    fileHandlePrototype.stat = originalStat;
    fileHandlePrototype.read = originalRead;
  }

  assert.equal(grewAfterStat, true);
  assert.ok(
    bytesRead <= initial.length + 1,
    `read ${bytesRead} bytes for a ${initial.length}-byte source entry`,
  );
});

test("source archive rejects queued source errors without an uncaught exception", async (t) => {
  const { root, project, output } = await createProject(
    t,
    "iskra-app-source-error-",
  );
  await writeSparse(
    join(project, "src", "a-large.bin"),
    SOURCE_MAX_ENTRY_BYTES,
  );
  const queued = join(project, "src", "z-queued.ts");
  await writeFile(queued, "queued");
  const previous = Buffer.from("previous-good-archive");
  await writeFile(output, previous);
  const archiveModule = pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist",
      "source-archive.js",
    ),
  ).href;
  const script = `
    import assert from "node:assert/strict";
    import { packSourceArchive } from ${JSON.stringify(archiveModule)};
    await assert.rejects(packSourceArchive(${JSON.stringify(project)}, ${JSON.stringify(output)}));
    process.stdout.write("rejected\\n");
  `;

  const temporarySeen = waitForTemporary(root, basename(output));
  const child = execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { timeout: 10_000 },
  ).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  await temporarySeen;
  await rm(queued);
  const outcome = await child;

  assert.equal(
    outcome.error,
    undefined,
    outcome.error?.stderr || outcome.error?.message,
  );
  assert.equal(outcome.result.stdout, "rejected\n");
  assert.deepEqual(await readFile(output), previous);
  await assertNoTemporary(root, basename(output));
});

test("source archive rejects special entries", async (t) => {
  const { project, output } = await createProject(
    t,
    "iskra-app-source-special-",
  );
  await execFileAsync("mkfifo", [join(project, "src", "events.pipe")]);

  await assertAtomicFailure(project, output, /unsupported source entry/i);
});

test("source archive rejects SOURCE_MAX_FILES + 1 files atomically", async (t) => {
  const { project, output } = await createProject(t, "iskra-app-source-files-");
  const files = join(project, "src", "many-files");
  await mkdir(files);
  await createMany(SOURCE_MAX_FILES - 1, (index) =>
    writeFile(join(files, `${String(index).padStart(4, "0")}.ts`), ""),
  );

  await assertAtomicFailure(project, output, /file count limit/i);
});

test("source archive rejects SOURCE_MAX_DIRECTORIES + 1 directories atomically", async (t) => {
  const { project, output } = await createProject(
    t,
    "iskra-app-source-directories-",
  );
  await createMany(SOURCE_MAX_DIRECTORIES, (index) =>
    mkdir(join(project, "src", `dir-${String(index).padStart(4, "0")}`)),
  );

  await assertAtomicFailure(project, output, /directory count limit/i);
});

test("source archive bounds inspected directory entries before filtering", async (t) => {
  const { project, output } = await createProject(
    t,
    "iskra-app-source-inspected-",
  );
  await createMany(SOURCE_MAX_FILES + SOURCE_MAX_DIRECTORIES + 1, (index) =>
    writeFile(
      join(project, "src", `.env-${String(index).padStart(4, "0")}`),
      "excluded",
    ),
  );

  await assertAtomicFailure(project, output, /inspected entry limit/i);
});

test("source archive rejects SOURCE_MAX_ENTRY_BYTES + 1 atomically", async (t) => {
  const { project, output } = await createProject(t, "iskra-app-source-entry-");
  await writeSparse(
    join(project, "src", "oversized.bin"),
    SOURCE_MAX_ENTRY_BYTES + 1,
  );

  await assertAtomicFailure(project, output, /entry size limit/i);
});

test("source archive rejects SOURCE_MAX_TOTAL_BYTES + 1 atomically", async (t) => {
  const { project, output } = await createProject(t, "iskra-app-source-total-");
  await writeFile(join(project, "app.json"), "");
  await writeFile(join(project, "src", "server.ts"), "");
  for (let index = 0; index < 4; index += 1) {
    await writeSparse(
      join(project, "src", `part-${index}.bin`),
      SOURCE_MAX_ENTRY_BYTES,
    );
  }
  await writeFile(join(project, "src", "plus-one.bin"), "x");

  await assertAtomicFailure(project, output, /total size limit/i);
});

test("source archive requires app.json and src", async (t) => {
  const missingApp = await createProject(t, "iskra-app-source-no-app-");
  await rm(join(missingApp.project, "app.json"));
  await assert.rejects(
    () => packSourceArchive(missingApp.project, missingApp.output),
    /app\.json|ENOENT/,
  );

  const missingSource = await createProject(t, "iskra-app-source-no-src-");
  await rm(join(missingSource.project, "src"), { recursive: true });
  await assert.rejects(
    () => packSourceArchive(missingSource.project, missingSource.output),
    /src|ENOENT/,
  );
});

test("source archive rejects direct and symlinked output paths inside the project", async (t) => {
  const direct = await createProject(t, "iskra-app-source-output-direct-");
  await assertAtomicFailure(
    direct.project,
    join(direct.project, "source.zip"),
    /outside project root/i,
  );

  const linked = await createProject(t, "iskra-app-source-output-link-");
  const insideParent = join(linked.project, "artifacts");
  const outsideLink = join(linked.root, "output-link");
  await mkdir(insideParent);
  await symlink(insideParent, outsideLink, "dir");
  await assertAtomicFailure(
    linked.project,
    join(outsideLink, "source.zip"),
    /outside project root/i,
  );
});

test("source archive rejects an output parent swapped after temp creation", async (t) => {
  const { root, project } = await createProject(
    t,
    "iskra-app-source-parent-swap-",
  );
  await writeSparse(
    join(project, "src", "a-large.bin"),
    SOURCE_MAX_ENTRY_BYTES,
  );
  const firstParent = join(root, "first-parent");
  const secondParent = join(root, "second-parent");
  const outputLink = join(root, "output-parent");
  const replacementLink = join(root, "output-parent-replacement");
  const outputName = "source.zip";
  const previous = Buffer.from("previous-good-archive");
  await mkdir(firstParent);
  await mkdir(secondParent);
  await writeFile(join(firstParent, outputName), previous);
  await writeFile(join(secondParent, outputName), previous);
  await symlink(firstParent, outputLink, "dir");
  await symlink(secondParent, replacementLink, "dir");

  const temporarySeen = waitForTemporary(firstParent, outputName);
  const packing = packSourceArchive(project, join(outputLink, outputName));
  const rejection = assert.rejects(packing, /output parent changed/i);
  void rejection.catch(() => undefined);
  await temporarySeen;
  await rename(replacementLink, outputLink);
  await rejection;

  assert.deepEqual(await readFile(join(firstParent, outputName)), previous);
  assert.deepEqual(await readFile(join(secondParent, outputName)), previous);
  await assertNoTemporary(firstParent, outputName);
  await assertNoTemporary(secondParent, outputName);
});

test("source archive removes its temporary after the output directory moves", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux stable descriptor paths are required");
    return;
  }
  const { root, project } = await createProject(
    t,
    "iskra-app-source-parent-move-",
  );
  await writeSparse(
    join(project, "src", "a-large.bin"),
    SOURCE_MAX_ENTRY_BYTES,
  );
  const outputParent = join(root, "output-parent");
  const movedParent = join(root, "moved-output-parent");
  const outputName = "source.zip";
  const output = join(outputParent, outputName);
  const previous = Buffer.from("previous-good-archive");
  await mkdir(outputParent);
  await writeFile(output, previous);

  const temporarySeen = waitForTemporary(outputParent, outputName);
  const packing = packSourceArchive(project, output);
  const rejection = assert.rejects(packing, /output parent changed/i);
  void rejection.catch(() => undefined);
  await temporarySeen;
  await rename(outputParent, movedParent);
  await mkdir(outputParent);
  await rejection;

  assert.deepEqual(await readFile(join(movedParent, outputName)), previous);
  await assert.rejects(() => readFile(output), /ENOENT|no such file/i);
  await assertNoTemporary(outputParent, outputName);
  await assertNoTemporary(movedParent, outputName);
});

test("source archive preserves its destination when temporary close fails", async (t) => {
  const { root, project, output } = await createProject(
    t,
    "iskra-app-source-temp-close-",
  );
  const previous = Buffer.from("previous-good-archive");
  await writeFile(output, previous);
  const archiveModule = pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist",
      "source-archive.js",
    ),
  ).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as fs from "node:fs/promises";
    import { basename } from "node:path";

    mock.module("node:fs/promises", {
      exports: {
        lstat: fs.lstat,
        open: async (path, ...args) => {
          const handle = await fs.open(path, ...args);
          if (
            basename(String(path)).startsWith(
              ${JSON.stringify(`${basename(output)}.tmp-`)},
            )
          ) {
            const close = handle.close.bind(handle);
            let closeAttempts = 0;
            handle.close = async () => {
              closeAttempts += 1;
              if (closeAttempts === 1) {
                throw new Error("injected temporary close failure");
              }
              return close();
            };
          }
          return handle;
        },
        opendir: fs.opendir,
        readlink: fs.readlink,
        realpath: fs.realpath,
        rename: fs.rename,
        rm: fs.rm,
        stat: fs.stat,
      },
    });
    const { packSourceArchive } = await import(
      ${JSON.stringify(`${archiveModule}?temporary-close`)}
    );
    const previous = Buffer.from("previous-good-archive");
    await assert.rejects(
      packSourceArchive(${JSON.stringify(project)}, ${JSON.stringify(output)}),
      /injected temporary close failure/i,
    );
    assert.deepEqual(await fs.readFile(${JSON.stringify(output)}), previous);
    assert.deepEqual(
      (await fs.readdir(${JSON.stringify(root)})).filter((name) =>
        name.startsWith("${basename(output)}.tmp-"),
      ),
      [],
    );
    process.stdout.write("close-failure-preserved\\n");
  `;

  const result = await execFileAsync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      script,
    ],
    { timeout: 10_000 },
  );
  assert.equal(result.stdout, "close-failure-preserved\n");
});

test("source archive does not remove a replaced temporary during cleanup", async (t) => {
  const { project, output } = await createProject(
    t,
    "iskra-app-source-temp-replaced-",
  );
  const previous = Buffer.from("previous-good-archive");
  await writeFile(output, previous);
  const archiveModule = pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist",
      "source-archive.js",
    ),
  ).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as fs from "node:fs/promises";
    import { basename } from "node:path";

    let replacementPath;
    mock.module("node:fs/promises", {
      exports: {
        lstat: fs.lstat,
        open: async (path, ...args) => {
          const handle = await fs.open(path, ...args);
          if (
            basename(String(path)).startsWith(
              ${JSON.stringify(`${basename(output)}.tmp-`)},
            )
          ) {
            const close = handle.close.bind(handle);
            let closeAttempts = 0;
            handle.close = async () => {
              closeAttempts += 1;
              if (closeAttempts === 1) {
                replacementPath = String(path);
                await close();
                await fs.rename(replacementPath, \`\${replacementPath}.moved\`);
                await fs.writeFile(replacementPath, "replacement-sentinel");
                throw new Error("injected temporary close failure after replacement");
              }
            };
          }
          return handle;
        },
        opendir: fs.opendir,
        readlink: fs.readlink,
        realpath: fs.realpath,
        rename: fs.rename,
        rm: fs.rm,
        stat: fs.stat,
      },
    });
    const { packSourceArchive } = await import(
      ${JSON.stringify(`${archiveModule}?temporary-replaced`)}
    );
    await assert.rejects(
      packSourceArchive(
        ${JSON.stringify(project)},
        ${JSON.stringify(output)},
        { requireStableDescriptors: false },
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        const details = error.errors.map(String).join("\\n");
        assert.match(details, /injected temporary close failure after replacement/i);
        assert.match(details, /temporary path changed/i);
        return true;
      },
    );
    assert.deepEqual(
      await fs.readFile(${JSON.stringify(output)}),
      Buffer.from("previous-good-archive"),
    );
    assert.equal(await fs.readFile(replacementPath, "utf8"), "replacement-sentinel");
    assert.ok((await fs.stat(\`\${replacementPath}.moved\`)).size > 0);
    process.stdout.write("replacement-preserved\\n");
  `;

  const result = await execFileAsync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      script,
    ],
    { timeout: 10_000 },
  );
  assert.equal(result.stdout, "replacement-preserved\n");
});

test("source archive can pack without stable descriptor paths", async (t) => {
  const { root, project, output } = await createProject(
    t,
    "iskra-app-source-path-fallback-",
  );
  const archiveModule = pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist",
      "source-archive.js",
    ),
  ).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as fs from "node:fs/promises";

    mock.module("node:fs/promises", {
      exports: {
        lstat: fs.lstat,
        open: fs.open,
        opendir: fs.opendir,
        readlink: async (path) => {
          if (String(path).startsWith("/proc/self/fd/")) {
            throw new Error("descriptor lookup unavailable");
          }
          return fs.readlink(path);
        },
        realpath: fs.realpath,
        rename: fs.rename,
        rm: fs.rm,
        stat: fs.stat,
      },
    });
    const { packSourceArchive } = await import(
      ${JSON.stringify(`${archiveModule}?path-fallback`)}
    );
    const result = await packSourceArchive(
      ${JSON.stringify(project)},
      ${JSON.stringify(output)},
      { requireStableDescriptors: false },
    );
    assert.equal(
      await fs.realpath(result),
      await fs.realpath(${JSON.stringify(output)}),
    );
    assert.ok((await fs.stat(${JSON.stringify(output)})).size > 0);
    assert.deepEqual(
      (await fs.readdir(${JSON.stringify(root)})).filter((name) =>
        name.startsWith("${basename(output)}.tmp-"),
      ),
      [],
    );
    process.stdout.write("path-fallback-packed\\n");
  `;

  const result = await execFileAsync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      script,
    ],
    { timeout: 10_000 },
  );
  assert.equal(result.stdout, "path-fallback-packed\n");
});

test("source archive rejects unavailable stable descriptor paths before temp creation", async (t) => {
  if (process.platform === "darwin") {
    t.skip("strict stable descriptor paths require Linux /proc/self/fd");
    return;
  }
  const { root, project, output } = await createProject(
    t,
    "iskra-app-source-descriptor-prerequisite-",
  );
  const previous = Buffer.from("previous-good-archive");
  await writeFile(output, previous);
  const archiveModule = pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "dist",
      "source-archive.js",
    ),
  ).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import * as fs from "node:fs/promises";

    mock.module("node:fs/promises", {
      exports: {
        lstat: fs.lstat,
        open: fs.open,
        opendir: fs.opendir,
        readlink: async (path) => {
          if (String(path).startsWith("/proc/self/fd/")) {
            throw new Error("descriptor lookup unavailable");
          }
          return fs.readlink(path);
        },
        realpath: fs.realpath,
        rename: fs.rename,
        rm: fs.rm,
        stat: fs.stat,
      },
    });
    const { packSourceArchive } = await import(
      ${JSON.stringify(`${archiveModule}?descriptor-prerequisite`)}
    );
    const previous = Buffer.from("previous-good-archive");
    await assert.rejects(
      packSourceArchive(
        ${JSON.stringify(project)},
        ${JSON.stringify(output)},
        { requireStableDescriptors: true },
      ),
      /stable descriptor path/i,
    );
    assert.deepEqual(await fs.readFile(${JSON.stringify(output)}), previous);
    assert.deepEqual(
      (await fs.readdir(${JSON.stringify(root)})).filter((name) =>
        name.startsWith("${basename(output)}.tmp-"),
      ),
      [],
    );
    process.stdout.write("rejected-before-temp\\n");
  `;

  const result = await execFileAsync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      script,
    ],
    { timeout: 10_000 },
  );
  assert.equal(result.stdout, "rejected-before-temp\n");
});

test("source archive requires an existing output parent", async (t) => {
  const { root, project } = await createProject(t, "iskra-app-source-parent-");
  const output = join(root, "missing", "source.zip");

  await assert.rejects(
    () => packSourceArchive(project, output),
    /ENOENT|no such file/i,
  );
  await assert.rejects(() => readdir(dirname(output)), /ENOENT|no such file/i);
});

test("source-pack CLI resolves and prints custom and default outputs", async (t) => {
  const { root, project } = await createProject(t, "iskra-app-source-cli-");
  const cli = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "dist",
    "cli.js",
  );
  const customOutput = join(root, "custom-source.zip");
  const custom = await execFileAsync(
    process.execPath,
    [cli, "source-pack", "--path", project, "--output", "custom-source.zip"],
    { cwd: root },
  );
  assert.equal(
    await realpath(custom.stdout.trim()),
    await realpath(customOutput),
  );
  assert.deepEqual(zipEntryNames(await readFile(customOutput)), [
    "app.json",
    "src/server.ts",
  ]);

  const expectedDefault = `${project}-source.zip`;
  const defaultResult = await execFileAsync(
    process.execPath,
    [cli, "source-pack", "--path", project],
    { cwd: root },
  );
  assert.equal(
    await realpath(defaultResult.stdout.trim()),
    await realpath(expectedDefault),
  );
  assert.deepEqual(zipEntryNames(await readFile(expectedDefault)), [
    "app.json",
    "src/server.ts",
  ]);
});
