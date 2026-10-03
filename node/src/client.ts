import type { HeadlessResponse } from "./interactive.js";

export interface IskraClientOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface RunStart {
  readonly runId: string;
  readonly conversationId?: string;
  readonly status: string;
  readonly expiresAt?: string;
}

export interface RunEvent {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly data: unknown;
}

export interface RunStatus<TResult = HeadlessResponse> {
  readonly runId?: string;
  readonly conversationId?: string;
  readonly status: string;
  readonly result?: TResult;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly events: readonly RunEvent[];
  readonly nextAfter: number;
}

export interface StartRunOptions {
  readonly idempotencyKey: string;
}

export interface IskraAPIErrorMetadata {
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly requestId?: string | undefined;
  readonly retryAfter?: string | undefined;
}

export class IskraAPIError extends Error implements IskraAPIErrorMetadata {
  readonly status: number;
  readonly code: string;

  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly requestId?: string | undefined;
  readonly retryAfter?: string | undefined;

  constructor(status: number, code: string, message: string, metadata: IskraAPIErrorMetadata = {}) {
    super(message);
    this.name = "IskraAPIError";
    this.status = status;
    this.code = code;
    this.title = metadata.title;
    this.detail = metadata.detail;
    this.requestId = metadata.requestId;
    this.retryAfter = metadata.retryAfter;
  }
}

export class IskraClient {
  readonly #apiUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: IskraClientOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, "");
    if (!this.#apiUrl || !options.token) throw new Error("apiUrl и token обязательны");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async run<TOutput = unknown>(input: unknown, options: StartRunOptions): Promise<HeadlessResponse<TOutput>> {
    return this.#request("POST", "/api/v1/chat", input, {
      "idempotency-key": options.idempotencyKey,
    }) as Promise<HeadlessResponse<TOutput>>;
  }

  async startRun(input: unknown, options: StartRunOptions): Promise<RunStart> {
    const wire = (await this.#request("POST", "/api/v1/runs", input, {
      "idempotency-key": options.idempotencyKey,
    })) as Record<string, unknown>;
    return {
      runId: requiredString(wire.run_id, "run_id"),
      status: requiredString(wire.status, "status"),
      ...(typeof wire.conversation_id === "string" ? { conversationId: wire.conversation_id } : {}),
      ...(typeof wire.expires_at === "string" ? { expiresAt: wire.expires_at } : {}),
    };
  }

  async getRun<TResult = HeadlessResponse>(
    runId: string,
    after = 0,
    signal?: AbortSignal,
  ): Promise<RunStatus<TResult>> {
    const wire = (await this.#request(
      "GET",
      `/api/v1/runs/${encodeURIComponent(runId)}?after=${after}`,
      undefined,
      {},
      signal,
    )) as Record<string, unknown>;
    return {
      status: requiredString(wire.status, "status"),
      events: Array.isArray(wire.events) ? (wire.events as RunEvent[]) : [],
      nextAfter: typeof wire.next_after === "number" ? wire.next_after : after,
      ...(typeof wire.run_id === "string" ? { runId: wire.run_id } : {}),
      ...(typeof wire.conversation_id === "string" ? { conversationId: wire.conversation_id } : {}),
      ...(wire.result !== undefined ? { result: wire.result as TResult } : {}),
      ...(wire.error === null || isRunError(wire.error) ? { error: wire.error } : {}),
    };
  }

  async cancelRun(runId: string): Promise<RunStatus> {
    const wire = (await this.#request("DELETE", `/api/v1/runs/${encodeURIComponent(runId)}`)) as Record<
      string,
      unknown
    >;
    return {
      status: requiredString(wire.status, "status"),
      events: [],
      nextAfter: 0,
      ...(typeof wire.run_id === "string" ? { runId: wire.run_id } : {}),
    };
  }

  async *progress<TResult = HeadlessResponse>(
    runId: string,
    options: { after?: number; intervalMs?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<RunStatus<TResult>> {
    let after = options.after ?? 0;
    const intervalMs = options.intervalMs ?? 1000;
    for (;;) {
      options.signal?.throwIfAborted();
      const status = await this.getRun<TResult>(runId, after, options.signal);
      yield status;
      after = status.nextAfter;
      if (["completed", "interaction_required", "failed", "cancelled"].includes(status.status)) return;
      await delay(intervalMs, options.signal);
    }
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      ...extraHeaders,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.#fetch(`${this.#apiUrl}${path}`, {
      method,
      headers,
      ...(signal === undefined ? {} : { signal }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const problem = payload?.error;
      const code = isRunError(problem) ? problem.code : nonemptyString(payload?.code) ?? "request_failed";
      const message = isRunError(problem)
        ? problem.message
        : nonemptyString(payload?.detail) ?? nonemptyString(payload?.title) ?? `Искра ответила HTTP ${response.status}`;
      throw new IskraAPIError(response.status, code, message, {
        title: typeof payload?.title === "string" ? payload.title : undefined,
        detail: typeof payload?.detail === "string" ? payload.detail : undefined,
        requestId: nonemptyString(response.headers.get("x-request-id")) ?? nonemptyString(payload?.request_id),
        retryAfter: response.headers.get("retry-after") ?? undefined,
      });
    }
    return payload;
  }
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`ответ API не содержит ${name}`);
  return value;
}

function isRunError(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === "string" &&
    typeof (value as Record<string, unknown>).message === "string"
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
