import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import * as core from "../dist/cli-core.js";

const execFileAsync = promisify(execFile);
const sdkRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(sdkRoot, "dist", "cli.js");
const appId = "a47c39e4-60fe-4a30-b624-23be23ab2b01";
const apiKey = "isk_external_agent_secret";

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const captured = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(captured);
    await handler(captured, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { requests, apiUrl: `http://127.0.0.1:${server.address().port}` };
}

async function bundle(t) {
  const root = await mkdtemp(join(tmpdir(), "iskra-cli-external-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x42, 0x0a]);
  const path = join(root, "provided.zip");
  await writeFile(path, bytes);
  return { path, bytes };
}

function run(args, apiUrl) {
  return execFileAsync(process.execPath, [cli, ...args], {
    env: { ...process.env, ISKRA_API_URL: apiUrl, ISKRA_API_KEY: apiKey },
  });
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function failure(args, apiUrl) {
  const result = await run(args, apiUrl).then(
    () => assert.fail("command should fail"),
    (error) => error,
  );
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(apiKey));
  assert.doesNotMatch(result.stdout + result.stderr, /Bearer |authorization|RequestInit|\n\s+at /);
  return { ...result, output: JSON.parse(result.stdout) };
}

test("publish --bundle uploads exact archive and preserves no-activate and viewer URL", async (t) => {
  const archive = await bundle(t);
  const http = await fixture(t, (_request, response) =>
    json(response, 201, {
      id: appId,
      version: "1.2.3",
      state: "ready",
      current_version: "",
      activated: false,
      viewer_base_url: "https://apps.example.test/notes/",
    }),
  );
  const result = await run(
    ["publish", "--bundle", archive.path, "--app-id", appId, "--no-activate"],
    http.apiUrl,
  );
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    appId,
    version: "1.2.3",
    state: "ready",
    currentVersion: "",
    activated: false,
    viewerBaseUrl: "https://apps.example.test/notes/",
  });
  assert.equal(http.requests.length, 1);
  const [request] = http.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, `/api/v1/apps/${appId}/versions?activate=false`);
  assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
  const form = await new Request(http.apiUrl, {
    method: "POST",
    headers: request.headers,
    body: request.body,
  }).formData();
  assert.deepEqual([...form.keys()], ["bundle"]);
  assert.deepEqual(Buffer.from(await form.get("bundle").arrayBuffer()), archive.bytes);
});

for (const conflict of [["--path", "."], ["--output", "unused.zip"], ["--closed"]]) {
  test(`publish rejects --bundle with ${conflict[0]} before network or packaging`, async (t) => {
    const http = await fixture(t, (_request, response) => json(response, 500, {}));
    const result = await run(
      ["publish", "--bundle", "/missing.zip", ...conflict],
      http.apiUrl,
    ).catch((error) => error);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--bundle.*(несовместим|сочетать)/);
    assert.ok(result.stderr.includes(conflict[0]));
    assert.equal(http.requests.length, 0);
  });
}

test("status emits exact wire DTO after one authenticated version GET", async (t) => {
  const dto = {
    id: appId,
    slug: "notes",
    title: "Notes",
    status: "active",
    access: "private",
    current_version: "1.2.2",
    viewer_base_url: "https://apps.example.test/notes/",
    publication: { version: "1.2.3-beta+fix", state: "pending", activate_on_ready: true, probe_error: "healthz вернул 503" },
  };
  const http = await fixture(t, (_request, response) => json(response, 200, dto));
  const result = await run(
    ["status", "--app-id", appId, "--version", dto.publication.version],
    http.apiUrl,
  );
  assert.deepEqual(JSON.parse(result.stdout), dto);
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0].method, "GET");
  assert.equal(http.requests[0].url, `/api/v1/apps/${appId}?version=1.2.3-beta%2Bfix`);
  assert.equal(http.requests[0].headers.authorization, `Bearer ${apiKey}`);
  assert.equal(http.requests[0].body.length, 0);
});

test("access sends only access in one authenticated PATCH", async (t) => {
  const dto = { id: appId, access: "org", viewer_base_url: "https://apps.example.test/notes/" };
  const http = await fixture(t, (_request, response) => json(response, 200, dto));
  const result = await run(
    ["access", "--app-id", appId, "--access", "org", "--api-url", http.apiUrl],
    "http://unused.invalid",
  );
  assert.deepEqual(JSON.parse(result.stdout), dto);
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0].method, "PATCH");
  assert.equal(http.requests[0].url, `/api/v1/apps/${appId}/access`);
  assert.equal(http.requests[0].headers.authorization, `Bearer ${apiKey}`);
  assert.equal(http.requests[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(http.requests[0].body), { access: "org" });
});

for (const args of [
  ["status", "--app-id", appId],
  ["status", "--app-id", "broken", "--version", "1.0.0"],
  ["access", "--app-id", appId, "--access", "everyone"],
  ["access", "--app-id", "broken", "--access", "private"],
]) {
  test(`validates ${args.join(" ")} before network`, async (t) => {
    const http = await fixture(t, (_request, response) => json(response, 500, {}));
    const result = await run(args, http.apiUrl).catch((error) => error);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /UUID|--version|--access/);
    assert.equal(http.requests.length, 0);
  });
}

test("initial publish HTTP error preserves problem metadata and known identity", async (t) => {
  const archive = await bundle(t);
  const params = {
    reason: "invalid_entry",
    field: "main",
    path: "app.json",
    message: "entry file is missing",
  };
  const http = await fixture(t, (_request, response) => {
    response.setHeader("x-request-id", "req-header");
    json(response, 422, {
      code: "invalid_bundle",
      detail: "bundle rejected",
      params,
      request_id: "req-body",
    });
  });
  const result = await failure(
    ["publish", "--bundle", archive.path, "--app-id", appId],
    http.apiUrl,
  );
  assert.deepEqual(result.output, {
    error: "app_api_error",
    status: 422,
    code: "invalid_bundle",
    params,
    request_id: "req-header",
    app_id: appId,
    detail: "bundle rejected",
  });
  assert.equal(http.requests.length, 1);
});

test("status HTTP error retains exact version and problem request ID", async (t) => {
  const http = await fixture(t, (_request, response) =>
    json(response, 404, {
      code: "not_found",
      detail: "version missing",
      request_id: "req-body",
      params: { field: "version" },
    }),
  );
  const result = await failure(["status", "--app-id", appId, "--version", "1.2.3"], http.apiUrl);
  assert.deepEqual(result.output, {
    error: "app_api_error",
    status: 404,
    code: "not_found",
    request_id: "req-body",
    app_id: appId,
    version: "1.2.3",
    detail: "version missing",
    params: { field: "version" },
  });
  assert.equal(http.requests.length, 1);
});

test("access error omits credentials and request details from all output", async (t) => {
  const http = await fixture(t, (_request, response) =>
    json(response, 403, {
      code: "access_denied",
      detail: `cannot use ${apiKey}`,
      request_id: "req-denied",
      params: {
        reason: "scope",
        message: `rejected ${apiKey}`,
        authorization: `Bearer ${apiKey}`,
        headers: { "x-secret": apiKey },
      },
    }),
  );
  const result = await failure(["access", "--app-id", appId, "--access", "public"], http.apiUrl);
  assert.equal(result.output.error, "app_api_error");
  assert.equal(result.output.status, 403);
  assert.equal(result.output.code, "access_denied");
  assert.equal(result.output.params.reason, "scope");
  assert.ok(result.output.params.message.includes("[redacted]"));
});

for (const [status, body, expected] of [
  [502, "<html>upstream failed</html>", "app_api_error"],
  [201, "null", "app_publication_unknown"],
  [202, "[]", "app_publication_unknown"],
  [201, "{not json", "app_publication_unknown"],
]) {
  test(`publish preserves HTTP metadata for ${status} malformed/non-object response`, async (t) => {
    const archive = await bundle(t);
    const http = await fixture(t, (_request, response) => {
      response.writeHead(status, {
        "x-request-id": "req-malformed",
        "content-type": "application/json",
      });
      response.end(body);
    });
    const result = await failure(["publish", "--bundle", archive.path], http.apiUrl);
    assert.equal(result.output.error, expected);
    assert.equal(result.output.status, status);
    assert.equal(result.output.request_id, "req-malformed");
    assert.equal(result.output.app_id, undefined);
    assert.equal(result.output.version, undefined);
    assert.equal(http.requests.length, 1);
  });
}

test("preacceptance connection failure is unknown without POST retry or invented identity", async (t) => {
  const archive = await bundle(t);
  const http = await fixture(t, (_request, response) => response.destroy());
  const result = await failure(["publish", "--bundle", archive.path], http.apiUrl);
  assert.equal(result.output.error, "app_publication_unknown");
  assert.equal(result.output.app_id, undefined);
  assert.equal(result.output.version, undefined);
  assert.equal(http.requests.length, 1);
});

test("initial timeout is typed unknown and retains a known update app ID", async () => {
  let calls = 0;
  await assert.rejects(
    core.publishApp(new Blob(["bundle"]), {
      apiUrl: "http://iskra.invalid",
      apiKey,
      appId,
      timeoutMs: 20,
      fetch: async (_url, init) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      },
    }),
    (error) => {
      assert.equal(error.name, "PublicationUnknownError");
      assert.equal(error.appId, appId);
      assert.equal(error.version, undefined);
      assert.match(error.message, /не завершилась за отведённое время/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("accepted publication 4xx retains durable IDs and structured HTTP metadata", async () => {
  let calls = 0;
  await assert.rejects(
    core.publishApp(new Blob(["bundle"]), {
      apiUrl: "http://iskra.invalid",
      apiKey,
      pollIntervalMs: 1,
      timeoutMs: 1000,
      fetch: async () => {
        calls += 1;
        if (calls === 1)
          return Response.json({ id: appId, version: "2.0.0", state: "probing" }, { status: 202 });
        return Response.json(
          { code: "insufficient_scope", detail: "read denied", params: { reason: "scope" } },
          {
            status: 403,
            headers: { "x-request-id": "req-poll" },
          },
        );
      },
    }),
    (error) => {
      assert.ok(error instanceof core.PublicationFailedError);
      assert.equal(error.appId, appId);
      assert.equal(error.version, "2.0.0");
      assert.equal(error.status, 403);
      assert.equal(error.code, "insufficient_scope");
      assert.deepEqual(error.params, { reason: "scope" });
      assert.equal(error.requestId, "req-poll");
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("accepted probe failure CLI output retains durable IDs and diagnostic", async (t) => {
  const archive = await bundle(t);
  const http = await fixture(t, (request, response) => {
    if (request.method === "POST")
      return json(response, 202, { id: appId, version: "1.2.3", state: "probing" });
    response.setHeader("x-request-id", "req-probe-cli");
    json(response, 200, {
      publication: { version: "1.2.3", state: "pending", probe_error: "healthz вернул 503" },
    });
  });
  const result = await failure(["publish", "--bundle", archive.path], http.apiUrl);
  assert.equal(result.output.error, "app_publication_failed");
  assert.equal(result.output.app_id, appId);
  assert.equal(result.output.version, "1.2.3");
  assert.equal(result.output.detail, "healthz вернул 503");
  assert.equal(result.output.status, 200);
  assert.equal(result.output.request_id, "req-probe-cli");
});

test("non-JSON transient poll retries and preserves viewer URL from acceptance", async () => {
  let calls = 0;
  const result = await core.publishApp(new Blob(["bundle"]), {
    apiUrl: "http://iskra.invalid",
    apiKey,
    pollIntervalMs: 1,
    timeoutMs: 1000,
    fetch: async () => {
      calls += 1;
      if (calls === 1)
        return Response.json(
          {
            id: appId,
            version: "1.2.3",
            state: "probing",
            viewer_base_url: "https://apps.example.test/notes/",
          },
          { status: 202 },
        );
      if (calls === 2) return new Response("upstream failure", { status: 502 });
      return Response.json({
        current_version: "1.2.3",
        publication: { version: "1.2.3", state: "ready", outcome: "activated" },
      });
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.viewerBaseUrl, "https://apps.example.test/notes/");
  assert.equal(result.activated, true);
});

test("API diagnostics redact credential header text and request options", async (t) => {
  const http = await fixture(t, (_request, response) =>
    json(response, 403, {
      code: "denied",
      detail: `received Bearer ${apiKey}`,
      params: { reason: "scope", requestInit: { method: "PATCH", body: "sensitive request" } },
    }),
  );
  const result = await failure(["access", "--app-id", appId, "--access", "org"], http.apiUrl);
  assert.equal(result.output.params.reason, "scope");
  assert.equal(result.output.params.requestInit, undefined);
});

test("stderr stays concise while structured diagnostics retain full safe detail", async (t) => {
  const detail = "invalid bundle: " + "x".repeat(3000);
  const http = await fixture(t, (_request, response) =>
    json(response, 400, { code: "invalid_bundle", detail }),
  );
  const result = await failure(["status", "--app-id", appId, "--version", "1.2.3"], http.apiUrl);
  assert.equal(result.output.detail, detail);
  assert.ok(result.stderr.length <= 600, `stderr was ${result.stderr.length} characters`);
});

test("publish HTTP error recovers server-known IDs without discarding diagnostic params", async (t) => {
  const archive = await bundle(t);
  const params = { app_id: appId, version: "2.0.0", reason: "probe_arm_failed" };
  const http = await fixture(t, (_request, response) =>
    json(response, 503, {
      code: "publication_failed",
      detail: "probe could not be armed",
      params,
      request_id: "req-arm",
    }),
  );
  const result = await failure(["publish", "--bundle", archive.path], http.apiUrl);
  assert.equal(result.output.error, "app_api_error");
  assert.equal(result.output.app_id, appId);
  assert.equal(result.output.version, "2.0.0");
  assert.deepEqual(result.output.params, params);
  assert.equal(http.requests.length, 1);
});

test("accepted poll HTTP error prints durable IDs and complete problem metadata", async (t) => {
  const archive = await bundle(t);
  const http = await fixture(t, (request, response) => {
    if (request.method === "POST")
      return json(response, 202, { id: appId, version: "1.2.3", state: "probing" });
    response.setHeader("x-request-id", "req-poll-cli");
    json(response, 403, { code: "insufficient_scope", params: { reason: "apps:read" } });
  });
  const result = await failure(["publish", "--bundle", archive.path], http.apiUrl);
  assert.deepEqual(result.output, {
    error: "app_publication_failed",
    app_id: appId,
    version: "1.2.3",
    status: 403,
    code: "insufficient_scope",
    params: { reason: "apps:read" },
    request_id: "req-poll-cli",
    detail: "insufficient_scope",
  });
  assert.equal(http.requests.length, 2);
});

test("malformed status success retains HTTP metadata and requested identity", async (t) => {
  const http = await fixture(t, (_request, response) => {
    response.writeHead(200, { "x-request-id": "req-status-json" });
    response.end("<html>not a DTO</html>");
  });
  const result = await failure(["status", "--app-id", appId, "--version", "1.2.3"], http.apiUrl);
  assert.equal(result.output.error, "app_api_error");
  assert.equal(result.output.code, "invalid_api_response");
  assert.equal(result.output.status, 200);
  assert.equal(result.output.request_id, "req-status-json");
  assert.equal(result.output.app_id, appId);
  assert.equal(result.output.version, "1.2.3");
  assert.equal(http.requests.length, 1);
});

test("postacceptance body timeout stays probing with viewer URL and no activation claim", async () => {
  let calls = 0;
  const result = await core.publishApp(new Blob(["bundle"]), {
    apiUrl: "http://iskra.invalid",
    apiKey,
    pollIntervalMs: 1,
    timeoutMs: 30,
    fetch: async () => {
      calls += 1;
      if (calls === 1)
        return Response.json(
          {
            id: appId,
            version: "1.2.3",
            state: "probing",
            viewer_base_url: "https://apps.example.test/notes/",
          },
          { status: 202 },
        );
      return new Response(new ReadableStream({ start() {} }));
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, {
    appId,
    version: "1.2.3",
    state: "probing",
    activated: false,
    viewerBaseUrl: "https://apps.example.test/notes/",
  });
});


const validStatusDTO = {
  id: appId, slug: "notes", title: "Notes", access: "private", status: "active",
  publication: { version: "1.2.3", state: "ready", activate_on_ready: true, outcome: "activated" },
};

for (const command of ["status", "access"]) {
  const valid = command === "status" ? validStatusDTO : { id: appId, access: "org" };
  const malformed = [
    ["empty object", {}],
    ...Object.keys(valid).map((field) => [
      `missing ${field}`,
      Object.fromEntries(Object.entries(valid).filter(([name]) => name !== field)),
    ]),
    ["invalid access enum", { ...valid, access: "everyone" }],
    ["invalid optional current version", { ...valid, current_version: 5 }],
    ...(command === "status" ? [
      ["incomplete publication", { ...valid, publication: {} }],
      ["invalid activation flag", { ...valid, publication: { ...valid.publication, activate_on_ready: "true" } }],
      ["invalid publication outcome", { ...valid, publication: { ...valid.publication, outcome: "unknown" } }],
    ] : []),
  ];
  for (const [label, dto] of malformed) {
    test(`${command} rejects contract-invalid successful response: ${label}`, async (t) => {
      const http = await fixture(t, (_request, response) => {
        response.setHeader("x-request-id", "req-invalid-success");
        json(response, 200, dto);
      });
      const args = command === "status"
        ? ["status", "--app-id", appId, "--version", "1.2.3"]
        : ["access", "--app-id", appId, "--access", "org"];
      const result = await failure(args, http.apiUrl);
      assert.equal(result.output.error, "app_api_error");
      assert.equal(result.output.status, 200);
      assert.equal(result.output.code, "invalid_api_response");
      assert.equal(result.output.request_id, "req-invalid-success");
      assert.equal(result.output.app_id, appId);
      if (command === "status") assert.equal(result.output.version, "1.2.3");
      assert.equal(http.requests.length, 1);
    });
  }
}
