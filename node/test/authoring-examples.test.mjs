import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildApp, packProject, scaffoldApp } from "../dist/cli-core.js";
import { APP_LAYOUTS } from "../dist/starter.js";
import { APP_CSP } from "../dist/index.js";
import { authoringExample } from "./fixtures/authoring-example.mjs";

const sdkRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);
const examples = [
  "minimal",
  "interactive",
  "stateful",
  ...APP_LAYOUTS.map((name) => `layouts/${name}`),
];

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "iskra-authoring-examples-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function form(fields) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  };
}

test("all authoring examples serve prefixed pages, assets and runtime health", async (t) => {
  const data = await temporary(t);
  for (const name of examples) {
    await t.test(name, async (t) => {
      const fixture = await authoringExample(t, join(sdkRoot, "examples", name), {
        env: { DATA_DIR: data },
      });
      assert.deepEqual(await (await fixture.health()).json(), { ok: true });
      const response = await fixture.request();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-security-policy"), APP_CSP);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const html = await response.text();
      const manifest = JSON.parse(await readFile(join(sdkRoot, "examples", name, "app.json")));
      assert.ok(html.includes(`<title>${manifest.name}</title>`));
      assert.doesNotMatch(html, /<style|<script(?![^>]*\ssrc=)|\sstyle=/);
      const style = await fixture.request("iskra.css");
      assert.equal(style.status, 200);
      assert.match(style.headers.get("content-type"), /text\/css/);
      assert.ok((await style.text()).length > 100);
      const titled = await (
        await fixture.request("", {
          headers: { "x-iskra-app-title": encodeURIComponent("Название владельца") },
        })
      ).text();
      assert.match(titled, /<title>Название владельца<\/title>/);
    });
  }
});

test("layout HTTP actions preserve forms, filters, selection, navigation and wizard state", async (t) => {
  const fixture = async (name) => authoringExample(t, join(sdkRoot, "examples/layouts", name));
  const supplier = "ООО «Северный склад»";
  const requestForm = await fixture("form");
  const rejected = await requestForm.request(
    "",
    form({ supplier, item: "", quantity: "2", deadline: "2026-10-06", comment: "" }),
  );
  assert.equal(rejected.status, 422);
  const created = await requestForm.request(
    "",
    form({
      supplier,
      item: "Test <paper>",
      quantity: "2",
      deadline: "2026-10-06",
      comment: "keep & check",
    }),
  );
  assert.equal(created.status, 303);
  const receipt = await (
    await requestForm.request(created.headers.get("location").replace(/^\.\//, ""))
  ).text();
  assert.match(receipt, /Test &lt;paper&gt;/);
  assert.match(receipt, /keep &amp; check/);

  const table = await fixture("table");
  const full = await (await table.request()).text();
  const searched = await (await table.request(`?q=${encodeURIComponent("0418")}`)).text();
  assert.match(searched, /ТН-2026-0418/);
  assert.doesNotMatch(searched, /ТН-2026-0417/);
  assert.ok(full.includes("ТН-2026-0417"));

  const master = await fixture("master-detail");
  const selected = await (await master.request("?id=technosnab")).text();
  assert.match(selected, /7705987654/);
  assert.doesNotMatch(selected, /7810123456/);
  assert.equal((await master.request("?id=unknown")).status, 404);

  const sidebar = await fixture("sidebar");
  const invoices = await (await sidebar.request()).text();
  const suppliers = await (await sidebar.request("?section=suppliers")).text();
  const reports = await (await sidebar.request("?section=reports")).text();
  assert.match(invoices, /ТН-2026-0418/);
  assert.doesNotMatch(suppliers, /ТН-2026-0418/);
  assert.match(suppliers, /Северный склад/);
  assert.match(reports, /109[\s\u00a0]?950,00/);
  assert.match(reports, /463[\s\u00a0]?956,24/);
  assert.equal((await sidebar.request("?section=unknown")).status, 404);

  const dashboard = await fixture("dashboard");
  const dashboardHTML = await (await dashboard.request()).text();
  assert.match(dashboardHTML, /109[\s\u00a0]?950/);
  assert.match(dashboardHTML, /230[\s\u00a0]?000/);

  const wizard = await fixture("wizard");
  const first = await (await wizard.request()).text();
  const draft = first.match(/name="draft" value="([^"]+)"/)[1];
  const step2 = await wizard.request(
    "",
    form({ draft, step: "1", supplier, number: "custom-invoice" }),
  );
  assert.equal(step2.status, 303);
  const step3 = await wizard.request(
    "",
    form({ draft, step: "2", amount: "123.50", dueDate: "2026-10-08" }),
  );
  assert.equal(step3.status, 303);
  const review = await (
    await wizard.request(step3.headers.get("location").replace(/^\.\//, ""))
  ).text();
  assert.match(review, /custom-invoice/);
  assert.match(review, /123,50/);
  const registered = await wizard.request("", form({ draft, step: "3" }));
  assert.equal(registered.status, 303);
  const confirmation = await (
    await wizard.request(registered.headers.get("location").replace(/^\.\//, ""))
  ).text();
  assert.match(confirmation, /custom-invoice/);
  assert.match(confirmation, /123,50/);
});

test("SDK init copies modules and applies identity, style and manifest contracts", async (t) => {
  const root = await temporary(t);
  for (const layout of [undefined, ...APP_LAYOUTS]) {
    await t.test(layout ?? "minimal", async (t) => {
      const project = join(root, layout ?? "minimal");
      const name = `copied-${layout ?? "minimal"}`;
      await scaffoldApp(project, { name, style: "showcase", ...(layout ? { layout } : {}) });
      const manifest = JSON.parse(await readFile(join(project, "app.json")));
      assert.equal(manifest.name, name);
      assert.equal(manifest.entry, "server.js");
      assert.deepEqual(manifest.storage, { kind: "sqlite" });
      const original = JSON.parse(
        await readFile(
          join(sdkRoot, "examples", layout ? `layouts/${layout}` : "minimal", "app.json"),
        ),
      );
      assert.equal(manifest.version, layout ? original.version : "0.1.0");
      await buildApp(project, { closedDependencies: true });
      const fixture = await authoringExample(t, project);
      const html = await (await fixture.request()).text();
      assert.match(html, new RegExp(`<title>${name}</title>`));
      assert.match(html, /data-style="showcase"/);
    });
  }
});

test("SDK init preserves an existing author module on a copy collision", async (t) => {
  const project = await temporary(t);
  await mkdir(join(project, "src"));
  const authorFile = join(project, "src/views.ts");
  const contents = "export const authorContent = 'keep this module';\n";
  await writeFile(authorFile, contents);
  await assert.rejects(scaffoldApp(project, { name: "collision", layout: "table" }), {
    code: "ERR_FS_CP_EEXIST",
  });
  assert.equal(await readFile(authorFile, "utf8"), contents);
});

async function extractedRuntime(t, example) {
  const root = await temporary(t);
  const project = join(root, "project");
  await cp(join(sdkRoot, "examples", example), project, { recursive: true });
  const output = join(root, "runtime.zip");
  await packProject(project, output, { closedDependencies: true });
  const runtime = join(root, "runtime");
  await execFileAsync("unzip", ["-q", output, "-d", runtime]);
  const data = join(root, "data");
  await mkdir(data);
  return { runtime, data };
}

async function launch(t, runtime, data) {
  let errors = "";
  const child = spawn(process.execPath, [join(runtime, "server.js")], {
    cwd: runtime,
    env: { ...process.env, APP_BASE_PATH: "/public-prefix", DATA_DIR: data },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await stopped;
  };
  t.after(stop);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail(`runtime завершился: ${errors}`);
    try {
      const response = await fetch("http://127.0.0.1:8080/healthz");
      if (response.ok)
        return {
          stop,
          request: (path = "", init = {}) =>
            fetch(`http://127.0.0.1:8080/public-prefix/${path}`, { ...init, redirect: "manual" }),
        };
    } catch {
      /* Ждём bind реального распакованного runtime. */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`runtime не запустился: ${errors}`);
}

test("extracted interactive ZIP serves its real browser asset under the app prefix", async (t) => {
  const { runtime, data } = await extractedRuntime(t, "interactive");
  const fixture = await launch(t, runtime, data);
  const page = await (await fixture.request()).text();
  const scriptPath = page.match(/<script src="([^"]+)"/)[1];
  const response = await fixture.request(scriptPath);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  const { runInNewContext } = await import("node:vm");
  let submit;
  runInNewContext(await response.text(), {
    document: {
      querySelector: () => ({
        addEventListener: (_event, callback) => {
          submit = callback;
        },
      }),
    },
  });
  assert.equal(typeof submit, "function");
  assert.deepEqual(
    await readFile(join(runtime, "static/screen.js")),
    await readFile(join(sdkRoot, "examples/interactive/static/screen.js")),
  );
  assert.equal(JSON.parse(await readFile(join(runtime, "app.json"))).name, "interactive-form");
});

test("extracted stateful runtime preserves SQLite notes across a restart", async (t) => {
  const { runtime, data } = await extractedRuntime(t, "stateful");
  const first = await launch(t, runtime, data);
  const response = await first.request("notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "saved <note>" }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  await first.stop();
  const second = await launch(t, runtime, data);
  assert.deepEqual((await (await second.request("notes")).json()).notes, [created]);
  assert.match(await (await second.request()).text(), /saved &lt;note&gt;/);
});
