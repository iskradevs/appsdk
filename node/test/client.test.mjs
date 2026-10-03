import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

import { IskraAPIError, IskraClient, isInteractionRequired } from "../dist/index.js";

test("sync actions preserve their idempotency key across retries", async () => {
  const calls = [];
  const client = new IskraClient({
    apiUrl: "http://api",
    token: "viewer.jwt",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        conversation_id: "conversation-1",
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const input = { message: "Проверь" };
  await client.run(input, { idempotencyKey: "action-1" });
  await client.run(input, { idempotencyKey: "action-1" });
  await client.run(input, { idempotencyKey: "action-2" });
  assert.deepEqual(
    calls.map(({ init }) => init.headers["idempotency-key"]),
    ["action-1", "action-1", "action-2"],
  );
  assert.ok(
    calls.every(
      ({ url, init }) =>
        url === "http://api/api/v1/chat" &&
        init.method === "POST" &&
        init.headers.authorization === "Bearer viewer.jwt",
    ),
  );
  assert.deepEqual(
    calls.map(({ init }) => JSON.parse(init.body)),
    [input, input, input],
  );
});

test("headless client sends viewer token and idempotency key", async () => {
  const calls = [];
  const client = new IskraClient({
    apiUrl: "http://iskra-api:8091/__iskra/",
    token: "viewer.jwt",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ run_id: "run-1", status: "queued" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const run = await client.startRun({ message: "Проверь" }, { idempotencyKey: "call-1" });
  assert.equal(run.runId, "run-1");
  assert.equal(calls[0].url, "http://iskra-api:8091/__iskra/api/v1/runs");
  assert.equal(calls[0].init.headers.authorization, "Bearer viewer.jwt");
  assert.equal(calls[0].init.headers["idempotency-key"], "call-1");
});

test("headless client exposes polling cursor and cancellation", async () => {
  const paths = [];
  const client = new IskraClient({
    apiUrl: "http://api",
    token: "token",
    fetch: async (url, init) => {
      paths.push(`${init.method} ${url}`);
      return new Response(
        JSON.stringify(
          url.includes("after=") ? { status: "running", next_after: 7, events: [] } : { status: "cancelled" },
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  const status = await client.getRun("run/1", 3);
  await client.cancelRun("run/1");
  assert.equal(status.nextAfter, 7);
  assert.deepEqual(paths, ["GET http://api/api/v1/runs/run%2F1?after=3", "DELETE http://api/api/v1/runs/run%2F1"]);
});

test("headless client exposes the actual snake_case interaction wire", async () => {
  const client = new IskraClient({
    apiUrl: "http://api",
    token: "token",
    fetch: async () =>
      Response.json({
        conversation_id: "conversation-1",
        status: "interaction_required",
        usage: { input_tokens: 3, output_tokens: 1 },
        interaction: {
          tool_call_id: "call-1",
          inputs: [{ name: "city", label: "Город", type: "text", required: true }],
        },
      }),
  });

  const result = await client.run({ message: "Погода" }, { idempotencyKey: "weather-action" });
  assert.equal(isInteractionRequired(result), true);
  assert.equal(result.interaction.tool_call_id, "call-1");
  assert.equal(result.interaction.inputs[0].name, "city");
  assert.equal("controls" in result.interaction, false);
  assert.equal(
    isInteractionRequired({
      status: "interaction_required",
      interaction: { tool_call_id: "call-1", inputs: [{ name: "city" }] },
    }),
    false,
  );
  assert.equal(
    isInteractionRequired({
      type: "interaction_required",
      id: "invented-step",
      controls: [],
    }),
    false,
  );
});

test("progress aborts an in-flight getRun fetch", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const client = new IskraClient({
    apiUrl: "http://api",
    token: "token",
    fetch: async (_url, init) => {
      receivedSignal = init.signal;
      if (!init.signal) throw new Error("polling fetch did not receive signal");
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });

  const pending = client.progress("run-1", { signal: controller.signal }).next();
  await Promise.resolve();
  controller.abort(new Error("stop polling"));
  await assert.rejects(pending, /stop polling/);
  assert.equal(receivedSignal, controller.signal);
});

test("progress delay removes its abort listener after the timer fires", async () => {
  let listeners = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    throwIfAborted() {},
    addEventListener() {
      listeners += 1;
    },
    removeEventListener() {
      listeners -= 1;
    },
  };
  let polls = 0;
  const client = new IskraClient({
    apiUrl: "http://api",
    token: "token",
    fetch: async () => {
      polls += 1;
      return Response.json({
        status: polls === 1 ? "running" : "completed",
        next_after: polls,
        events: [],
      });
    },
  });

  const progress = client.progress("run-1", { intervalMs: 1, signal });
  assert.equal((await progress.next()).value.status, "running");
  assert.equal((await progress.next()).value.status, "completed");
  assert.equal(listeners, 0);
});

async function withErrorServer(t, status, payload, headers = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.writeHead(status, { "content-type": "application/problem+json", ...headers });
    response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { calls, client: new IskraClient({
    apiUrl: `http://127.0.0.1:${server.address().port}/__iskra/`, token: "viewer.jwt",
  }) };
}

for (const [status, code, action] of [
  [401, "app_unauthorized", "sign_in"],
  [503, "app_auth_unavailable", "retry_later"],
]) {
  test(`native HTTP preserves backend Problem ${status} and does not retry`, async (t) => {
    // Формат shared/apierrors.ProblemFromError и Apps appauth.WriteFailure.
    const payload = { type: "about:blank", title: code, status, detail: "",
      instance: "urn:request:body-id", code, action, request_id: "body-id", params: {} };
    const { client, calls } = await withErrorServer(t, status, payload,
      { "X-Request-ID": "header-id", "Retry-After": "17" });
    await assert.rejects(client.run({ message: "hello" }, { idempotencyKey: "action-1" }), (error) => {
      assert.ok(error instanceof IskraAPIError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.equal(error.title, code);
      assert.equal(error.detail, "");
      assert.equal(error.requestId, "header-id");
      assert.equal(error.retryAfter, "17");
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "/__iskra/api/v1/chat");
    assert.equal(calls[0].headers.authorization, "Bearer viewer.jwt");
    assert.equal(calls[0].headers["idempotency-key"], "action-1");
    assert.deepEqual(JSON.parse(calls[0].body), { message: "hello" });
  });
}

test("Problem uses HTTP status, body request ID and raw HTTP-date Retry-After", async (t) => {
  const date = "Wed, 21 Oct 2026 07:28:00 GMT";
  const { client } = await withErrorServer(t, 503, {
    status: 200, code: "temporarily_unavailable", title: "Please wait", detail: "Try later",
    request_id: "body-id",
  }, { "X-Request-ID": "", "Retry-After": date });
  await assert.rejects(client.startRun({}, { idempotencyKey: "start-1" }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "temporarily_unavailable");
    assert.equal(error.message, "Try later");
    assert.equal(error.title, "Please wait");
    assert.equal(error.detail, "Try later");
    assert.equal(error.requestId, "body-id");
    assert.equal(error.retryAfter, date);
    return true;
  });
});

test("native error envelope takes priority over Problem code and message", async (t) => {
  const { client } = await withErrorServer(t, 409, {
    error: { code: "version_exists", message: "Existing version" },
    code: "other", detail: "Other detail", title: "Other title", request_id: "native-id",
  });
  await assert.rejects(client.run({}, { idempotencyKey: "native-1" }), (error) => {
    assert.equal(error.code, "version_exists");
    assert.equal(error.message, "Existing version");
    assert.equal(error.detail, "Other detail");
    assert.equal(error.requestId, "native-id");
    return true;
  });
});

test("empty or non-string Problem fields keep the HTTP fallback", async (t) => {
  const { client } = await withErrorServer(t, 502, {
    code: "", title: "", detail: 42, request_id: "",
  });
  await assert.rejects(client.run({}, { idempotencyKey: "empty-1" }), (error) => {
    assert.equal(error.code, "request_failed");
    assert.equal(error.message, "Искра ответила HTTP 502");
    assert.equal(error.requestId, undefined);
    assert.equal(error.detail, undefined);
    return true;
  });
});

test("non-JSON HTTP failure preserves status and response metadata", async (t) => {
  const { client } = await withErrorServer(t, 502, "gateway error", { "X-Request-ID": "gateway-id" });
  await assert.rejects(client.run({}, { idempotencyKey: "text-1" }), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, "request_failed");
    assert.equal(error.message, "Искра ответила HTTP 502");
    assert.equal(error.requestId, "gateway-id");
    return true;
  });
});

test("IskraAPIError keeps the three-argument constructor and optional metadata", () => {
  const old = new IskraAPIError(400, "invalid", "Invalid request");
  assert.ok(old instanceof Error);
  assert.equal(old.name, "IskraAPIError");
  assert.equal(old.status, 400);
  assert.equal(old.code, "invalid");
  assert.equal(old.message, "Invalid request");
  assert.equal(old.requestId, undefined);
  const extended = new IskraAPIError(503, "busy", "Busy", {
    title: "Busy", detail: "", requestId: "constructor-id", retryAfter: "5",
  });
  assert.equal(extended.title, "Busy");
  assert.equal(extended.detail, "");
  assert.equal(extended.requestId, "constructor-id");
  assert.equal(extended.retryAfter, "5");
});
