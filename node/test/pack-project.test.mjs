import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { watch, writeFileSync, renameSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sdkRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(sdkRoot, "dist/cli.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "iskra-sdk-project-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "notes");
  const temporary = join(root, "temporary");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "static/nested"), { recursive: true });
  await mkdir(temporary);
  await writeFile(join(project, "app.json"), JSON.stringify({
    name: "notes", version: "0.1.0", entry: "server.js", health: true,
    access: "private", storage: { kind: "sqlite" },
  }));
  await writeFile(join(project, "src/server.ts"), 'import { label } from "./label.js"; console.log(label);\n');
  await writeFile(join(project, "src/label.ts"), 'export const label = "first source value";\n');
  await writeFile(join(project, "static/nested/icon.bin"), Buffer.from([0, 255, 42]));
  await writeFile(join(project, "author-notes.txt"), "author-owned file\n");
  return { root, project, temporary, output: join(root, "notes.zip") };
}

function run(f, command, args = [], env = {}) {
  return execFileAsync(process.execPath, [cli, command, "--path", f.project, ...args], {
    env: { ...process.env, TMPDIR: f.temporary, ...env },
  });
}

function pack(f, output = f.output) {
  return run(f, "pack", ["--closed", "--output", output]);
}

async function snapshot(root) {
  const entries = {};
  async function walk(path, name) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) entries[name] = { link: await readlink(path) };
    else if (info.isDirectory()) {
      entries[name] = "directory";
      for (const entry of (await readdir(path)).sort())
        await walk(join(path, entry), name ? `${name}/${entry}` : entry);
    } else entries[name] = (await readFile(path)).toString("base64");
  }
  await walk(root, "");
  return entries;
}

async function assertCleanTemporary(f) {
  assert.deepEqual(await readdir(f.temporary), [], "pack оставил временные файлы");
}

async function archiveFile(output, name) {
  const { stdout } = await execFileAsync("unzip", ["-p", output, name], { encoding: "buffer" });
  return stdout;
}

async function bundleOutput(output) {
  const bundle = await archiveFile(output, "server.js");
  return (await execFileAsync(process.execPath, ["--input-type=module", "--eval", bundle.toString()])).stdout;
}

test("CLI pack writes a valid runtime ZIP and leaves only author files", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.project);
  await pack(f);

  assert.deepEqual(await snapshot(f.project), before);
  await assertCleanTemporary(f);
  await execFileAsync("unzip", ["-t", f.output]);
  const { stdout } = await execFileAsync("unzip", ["-Z1", f.output]);
  assert.deepEqual(stdout.trim().split("\n"), ["app.json", "server.js", "static/nested/icon.bin"]);
  assert.deepEqual(JSON.parse(await archiveFile(f.output, "app.json")), JSON.parse(await readFile(join(f.project, "app.json"))));
  assert.deepEqual(await archiveFile(f.output, "static/nested/icon.bin"), Buffer.from([0, 255, 42]));
  assert.equal(await bundleOutput(f.output), "first source value\n");
});

test("CLI pack remains deterministic with separately owned temporary builds", async (t) => {
  const f = await fixture(t);
  const second = join(f.root, "second.zip");
  await pack(f);
  await pack(f, second);
  assert.deepEqual(await readFile(second), await readFile(f.output));
  await assertCleanTemporary(f);
});

test("CLI pack rebuilds changes in a separately imported source module", async (t) => {
  const f = await fixture(t);
  await pack(f);
  await writeFile(join(f.project, "src/label.ts"), 'export const label = "updated source value";\n');
  const before = await snapshot(f.project);
  await pack(f);
  assert.equal(await bundleOutput(f.output), "updated source value\n");
  assert.deepEqual(await snapshot(f.project), before);
  await assertCleanTemporary(f);
});

test("CLI pack cleans staging when a closed dependency is rejected", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, "src/server.ts"), 'import Ajv from "ajv"; console.log(Ajv);');
  const before = await snapshot(f.project);
  await assert.rejects(pack(f), (error) => {
    assert.match(error.stderr, /закрытый набор зависимостей/);
    return true;
  });
  assert.deepEqual(await snapshot(f.project), before);
  await assertCleanTemporary(f);
  await assert.rejects(readFile(f.output), { code: "ENOENT" });
});

test("CLI pack cleans staging when writing the archive fails", async (t) => {
  const f = await fixture(t);
  await mkdir(f.output);
  const before = await snapshot(f.project);
  await assert.rejects(pack(f), (error) => {
    assert.match(error.stderr, /EISDIR/);
    return true;
  });
  assert.deepEqual(await snapshot(f.project), before);
  await assertCleanTemporary(f);
});

test("explicit CLI build keeps the unpacked runtime output", async (t) => {
  const f = await fixture(t);
  await run(f, "build", ["--closed"]);
  assert.equal(JSON.parse(await readFile(join(f.project, ".iskra-build/app.json"))).name, "notes");
  assert.equal((await execFileAsync(process.execPath, [join(f.project, ".iskra-build/server.js")])).stdout, "first source value\n");
  assert.deepEqual(await readFile(join(f.project, ".iskra-build/static/nested/icon.bin")), Buffer.from([0, 255, 42]));
  await assertCleanTemporary(f);
});

test("CLI pack retires a valid previous manual build after ZIP success", async (t) => {
  const f = await fixture(t);
  const authorFiles = await snapshot(f.project);
  await run(f, "build", ["--closed"]);
  await writeFile(join(f.project, "src/label.ts"), 'export const label = "new runtime value";\n');
  authorFiles["src/label.ts"] = (await readFile(join(f.project, "src/label.ts"))).toString("base64");
  await pack(f);
  assert.deepEqual(await snapshot(f.project), authorFiles);
  assert.equal(await bundleOutput(f.output), "new runtime value\n");
  await assertCleanTemporary(f);
});

test("CLI pack preserves legacy files changed after its initial validation", async (t) => {
  for (const change of ["unknown file", "replacement directory"]) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      await run(f, "build", ["--closed"]);
      const legacy = join(f.project, ".iskra-build");
      let changed = false;
      const watcher = watch(f.temporary, () => {
        if (changed) return;
        changed = true;
        if (change === "unknown file") {
          writeFileSync(join(legacy, "author-added-during-pack.txt"), "preserve this change");
        } else {
          const previous = join(f.root, "previous-build");
          renameSync(legacy, previous);
          mkdirSync(legacy);
          copyFileSync(join(previous, "app.json"), join(legacy, "app.json"));
          copyFileSync(join(previous, "server.js"), join(legacy, "server.js"));
        }
      });
      t.after(() => watcher.close());
      await assert.rejects(pack(f), (error) => {
        assert.match(error.stderr, /\.iskra-build/);
        return true;
      });
      assert.equal(changed, true, "fixture must change legacy after staging begins");
      assert.equal((await lstat(legacy)).isDirectory(), true);
      if (change === "unknown file") {
        assert.equal(await readFile(join(legacy, "author-added-during-pack.txt"), "utf8"), "preserve this change");
      } else {
        assert.equal(JSON.parse(await readFile(join(legacy, "app.json"))).name, "notes");
      }
      await execFileAsync("unzip", ["-t", f.output]);
      await assertCleanTemporary(f);
    });
  }
});

test("CLI pack preserves a previous manual build when rebuilding fails", async (t) => {
  const f = await fixture(t);
  await run(f, "build", ["--closed"]);
  await writeFile(join(f.project, "src/server.ts"), 'import Ajv from "ajv"; console.log(Ajv);');
  const before = await snapshot(f.project);
  await assert.rejects(pack(f), (error) => {
    assert.match(error.stderr, /закрытый набор зависимостей/);
    return true;
  });
  assert.deepEqual(await snapshot(f.project), before);
  await assertCleanTemporary(f);
});

test("CLI pack preserves a previous manual build when ZIP writing fails", async (t) => {
  const f = await fixture(t);
  await run(f, "build", ["--closed"]);
  await mkdir(f.output);
  const before = await snapshot(f.project);
  await assert.rejects(pack(f));
  assert.deepEqual(await snapshot(f.project), before);
  await assertCleanTemporary(f);
});

test("CLI pack preserves unknown or foreign files in the reserved build directory", async (t) => {
  const cases = {
    "hidden author file": (f, legacy) => writeFile(join(legacy, ".author-note"), "keep me"),
    "unknown directory": (f, legacy) => mkdir(join(legacy, "src")),
    "foreign app": (f, legacy) => writeFile(join(legacy, "app.json"), JSON.stringify({
      name: "another-app", version: "0.1.0", entry: "server.js", health: true,
      access: "private", storage: { kind: "sqlite" },
    })),
    "invalid manifest": (f, legacy) => writeFile(join(legacy, "app.json"), "{}"),
    "missing runtime entry": (f, legacy) => rm(join(legacy, "server.js")),
    "runtime entry directory": async (f, legacy) => {
      await rm(join(legacy, "server.js"));
      await mkdir(join(legacy, "server.js"));
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await run(f, "build", ["--closed"]);
      await change(f, join(f.project, ".iskra-build"));
      const before = await snapshot(f.project);
      await assert.rejects(pack(f), (error) => {
        assert.match(error.stderr, /\.iskra-build/);
        assert.match(error.stderr, /перемест|переимен|проверь/);
        return true;
      });
      assert.deepEqual(await snapshot(f.project), before);
      await assertCleanTemporary(f);
      await assert.rejects(readFile(f.output), { code: "ENOENT" });
    });
  }
});

test("CLI pack preserves symlinks anywhere in the previous build", async (t) => {
  for (const name of ["build root", "app.json", "server.js", "static", "static/nested/icon.bin"]) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await run(f, "build", ["--closed"]);
      const legacy = join(f.project, ".iskra-build");
      const path = name === "build root" ? legacy : join(legacy, name);
      const external = join(f.root, "external");
      if (name === "build root" || name === "static") {
        await mkdir(external);
        await writeFile(join(external, "personal-file"), "keep external data");
      } else await writeFile(external, await readFile(path));
      await rm(path, { recursive: true, force: true });
      await symlink(external, path);
      const before = await snapshot(f.project);
      const externalBefore = await snapshot(external);
      await assert.rejects(pack(f), (error) => {
        assert.match(error.stderr, /\.iskra-build/);
        return true;
      });
      assert.deepEqual(await snapshot(f.project), before);
      assert.deepEqual(await snapshot(external), externalBefore);
      await assertCleanTemporary(f);
    });
  }
});

test("CLI pack rejects an output inside the reserved build path before writing", async (t) => {
  for (const previousBuild of [false, true]) {
    await t.test(previousBuild ? "existing build" : "absent build", async (t) => {
      const f = await fixture(t);
      if (previousBuild) await run(f, "build", ["--closed"]);
      const before = await snapshot(f.project);
      await assert.rejects(pack(f, join(f.project, ".iskra-build/out.zip")), (error) => {
        assert.match(error.stderr, /\.iskra-build/);
        return true;
      });
      assert.deepEqual(await snapshot(f.project), before);
      await assertCleanTemporary(f);
    });
  }
});

test("CLI pack rejects symlink aliases to an output inside the previous build", async (t) => {
  for (const fileAlias of [false, true]) {
    await t.test(fileAlias ? "output file alias" : "output directory alias", async (t) => {
      const f = await fixture(t);
      await run(f, "build", ["--closed"]);
      const legacy = join(f.project, ".iskra-build");
      const alias = join(f.root, "output-alias");
      await symlink(fileAlias ? join(legacy, "server.js") : legacy, alias);
      const before = await snapshot(f.project);
      await assert.rejects(pack(f, fileAlias ? alias : join(alias, "nested/out.zip")), (error) => {
        assert.match(error.stderr, /\.iskra-build/);
        return true;
      });
      assert.deepEqual(await snapshot(f.project), before);
      await assertCleanTemporary(f);
    });
  }
});

test("CLI publish clears temporary builds on accepted and rejected publication", async (t) => {
  for (const accepted of [true, false]) {
    await t.test(accepted ? "accepted publication" : "rejected publication", async (t) => {
      const f = await fixture(t);
      const before = await snapshot(f.project);
      const requests = [];
      const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push({ url: request.url, bytes: Buffer.concat(chunks).length });
        response.setHeader("content-type", "application/json");
        response.statusCode = accepted ? 201 : 403;
        response.end(JSON.stringify(accepted
          ? { id: "app-notes", version: "0.1.0", state: "ready", activated: true }
          : { code: "insufficient_scope" }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => server.close());
      const env = {
        ISKRA_API_URL: `http://127.0.0.1:${server.address().port}`,
        ISKRA_API_KEY: "isk_secret",
      };
      const result = run(f, "publish", ["--closed", "--output", f.output], env);
      if (accepted) assert.equal(JSON.parse((await result).stdout).appId, "app-notes");
      else await assert.rejects(result, (error) => {
        assert.match(error.stderr, /insufficient_scope/);
        return true;
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "/api/v1/apps?activate=true");
      assert.ok(requests[0].bytes > (await readFile(f.output)).length);
      assert.deepEqual(await snapshot(f.project), before);
      await assertCleanTemporary(f);
      await execFileAsync("unzip", ["-t", f.output]);
    });
  }
});
