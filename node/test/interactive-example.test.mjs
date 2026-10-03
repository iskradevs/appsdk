import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const sdkRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Единственный шов — bind HTTP-порта. Исполняются реальные Hono routes,
// screen.js из ответа маршрута и собранный SDK с настоящим HTTP transport.
async function exampleFixture(
  t,
  result = {
    conversation_id: "conversation-1",
    status: "completed",
    answer: "ok",
    usage: { input_tokens: 1, output_tokens: 1 },
  },
) {
  const calls = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const previousURL = process.env.ISKRA_API_URL;
  const previousBase = process.env.APP_BASE_PATH;
  process.env.ISKRA_API_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.APP_BASE_PATH = "/interactive";
  t.after(() => {
    if (previousURL === undefined) delete process.env.ISKRA_API_URL;
    else process.env.ISKRA_API_URL = previousURL;
    if (previousBase === undefined) delete process.env.APP_BASE_PATH;
    else process.env.APP_BASE_PATH = previousBase;
  });
  const bundle = await build({
    stdin: {
      contents: `import ${JSON.stringify(join(sdkRoot, "examples/interactive/src/server.ts"))}; export { handler } from "example-listener";`,
      resolveDir: sdkRoot,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    alias: { "@iskra/apps": join(sdkRoot, "dist/index.js") },
    plugins: [
      {
        name: "capture-example-listener",
        setup(plugin) {
          plugin.onResolve({ filter: /^(@hono\/node-server|example-listener)$/ }, () => ({
            path: "listener",
            namespace: "example",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "example" }, () => ({
            contents: "export let handler; export function serve(options) { handler = options.fetch; }",
          }));
        },
      },
    ],
  });
  const { handler } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}#${webcrypto.randomUUID()}`
  );
  const request = (path, init = {}) => handler(new Request(`http://example.test/interactive/${path}`, init));
  const post = (body) =>
    request("run", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Iskra-Identity": "viewer.jwt" },
      body,
    });
  const script = await (await request("screen.js")).text();
  return {
    calls,
    post,
    screen(fetch) {
      let submit;
      const classes = new Set();
      const button = {
        disabled: false,
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
      };
      const status = { className: "", textContent: "" };
      const output = { textContent: "" };
      const input = { value: "Проверь" };
      const form = {
        addEventListener: (event, listener) => {
          assert.equal(event, "submit");
          submit = listener;
        },
        querySelector: () => button,
      };
      runInNewContext(script, {
        document: {
          querySelector: (selector) => ({ "#ask": form, "#status": status, "#result": output })[selector],
        },
        FormData: class {
          get() {
            return input.value;
          }
        },
        crypto: webcrypto,
        TypeError,
        fetch,
      });
      return {
        input,
        button,
        status,
        output,
        submit: () => submit({ preventDefault() {}, currentTarget: form }),
      };
    },
  };
}

test("interactive screen retries a lost response with the same action key and captured payload", async (t) => {
  const fixture = await exampleFixture(t);
  const screen = fixture.screen(async (_url, init) => {
    const response = await fixture.post(init.body);
    if (fixture.calls.length === 1) {
      await response.text(); // Upstream завершился; потерян только ответ браузеру.
      screen.input.value = "Другая задача";
      throw new TypeError("connection lost");
    }
    return response;
  });
  await screen.submit();
  assert.equal(fixture.calls.length, 2);
  const [first, retry] = fixture.calls;
  assert.ok(first.headers["idempotency-key"]);
  assert.equal(retry.headers["idempotency-key"], first.headers["idempotency-key"]);
  assert.equal(retry.body, first.body);
  assert.equal(JSON.parse(first.body).message, "Проверь");
  assert.equal(JSON.parse(screen.output.textContent).status, "completed");
  assert.equal(screen.button.disabled, false);
});

test("interactive screen starts a new action on every submit after interaction_required", async (t) => {
  const fixture = await exampleFixture(t, {
    status: "interaction_required",
    conversation_id: "conversation-1",
    usage: { input_tokens: 1, output_tokens: 1 },
    interaction: {
      tool_call_id: "tool-1",
      inputs: [{ name: "city", label: "Город", type: "text", required: true }],
    },
  });
  const screen = fixture.screen((_url, init) => fixture.post(init.body));
  await screen.submit();
  assert.equal(JSON.parse(screen.output.textContent).status, "interaction_required");
  await screen.submit();
  assert.equal(fixture.calls.length, 2);
  const keys = fixture.calls.map((call) => call.headers["idempotency-key"]);
  assert.ok(keys.every(Boolean));
  assert.notEqual(keys[0], keys[1]);
  assert.equal(fixture.calls[0].body, fixture.calls[1].body);
});

test("interactive screen bounds transport retries and does not retry an HTTP refusal", async (t) => {
  const fixture = await exampleFixture(t);
  let transportCalls = 0;
  const broken = fixture.screen(async () => {
    transportCalls++;
    throw new TypeError("offline");
  });
  await broken.submit();
  assert.equal(transportCalls, 2);
  assert.equal(broken.button.disabled, false);
  assert.equal(broken.status.className, "status status--error");
  let refusedCalls = 0;
  const refused = fixture.screen(async () => {
    refusedCalls++;
    return Response.json({ error: "denied" }, { status: 503 });
  });
  await refused.submit();
  assert.equal(refusedCalls, 1);
  assert.equal(refused.button.disabled, false);
  assert.equal(refused.status.className, "status status--error");
});

test("interactive run passes continuation inputs and the caller action key to the SDK", async (t) => {
  const fixture = await exampleFixture(t);
  for (const idempotency_key of ["action-1", "continuation-2", "continuation-2"]) {
    const response = await fixture.post(
      JSON.stringify({
        message: "Продолжи",
        conversation_id: "conversation-1",
        inputs: { city: "Омск" },
        idempotency_key,
      }),
    );
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.deepEqual(
    fixture.calls.map((call) => call.headers["idempotency-key"]),
    ["action-1", "continuation-2", "continuation-2"],
  );
  for (const call of fixture.calls) {
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/api/v1/chat");
    assert.equal(call.headers.authorization, "Bearer viewer.jwt");
    assert.deepEqual(JSON.parse(call.body), {
      message: "Продолжи",
      conversation_id: "conversation-1",
      policy: { inputs: { city: "Омск" } },
    });
  }
});

test("interactive run rejects missing or empty keys before an upstream request", async (t) => {
  const fixture = await exampleFixture(t);
  for (const idempotency_key of [undefined, "", "   "]) {
    const response = await fixture.post(JSON.stringify({ message: "Проверь", idempotency_key }));
    assert.equal(response.status, 400);
  }
  assert.equal(fixture.calls.length, 0);
});
