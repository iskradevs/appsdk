import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const sdkRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const environments = new WeakMap();

// Исполняется весь bootstrap и реальные Hono handlers. Единственный сетевой
// шов перехватывает bind; static-root задаётся явно без смены cwd процесса.
export async function authoringExample(t, project, options = {}) {
  let saved = environments.get(t);
  if (!saved) {
    saved = new Map();
    environments.set(t, saved);
    t.after(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }
  for (const [key, value] of Object.entries({ APP_BASE_PATH: "/example", ...options.env })) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const result = await build({
    stdin: {
      contents: `import ${JSON.stringify(join(project, "src/server.ts"))}; export { handler } from "example-listener";`,
      resolveDir: sdkRoot,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    alias: {
      "@iskra/apps": join(sdkRoot, "dist/index.js"),
    },
    plugins: [
      {
        name: "authoring-runtime-fixture",
        setup(plugin) {
          plugin.onResolve({ filter: /^(hono(?:\/.*)?|zod)$/ }, (args) => {
            if (args.pluginData?.fixtureResolved) return;
            return plugin.resolve(args.path, {
              resolveDir: sdkRoot,
              kind: args.kind,
              pluginData: { fixtureResolved: true },
            });
          });
          plugin.onResolve({ filter: /^(@hono\/node-server|example-listener)$/ }, () => ({
            path: "listener",
            namespace: "example-listener",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "example-listener" }, () => ({
            contents:
              "export let handler; export function serve(options) { handler = options.fetch; }",
          }));
          plugin.onResolve({ filter: /^@hono\/node-server\/serve-static$/ }, () => ({
            path: "static",
            namespace: "example-static",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "example-static" }, () => ({
            resolveDir: sdkRoot,
            contents: `import { serveStatic as actual } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@hono/node-server/serve-static")))};
export function serveStatic(options) { return actual({ ...options, root: ${JSON.stringify(options.staticRoot ?? join(project, "static"))} }); }`,
          }));
        },
      },
    ],
  });
  const { handler } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${randomUUID()}`
  );
  const base = options.env?.APP_BASE_PATH ?? "/example";
  return {
    request: (path = "", init = {}) =>
      handler(new Request(`http://example.test${base}/${path}`, init)),
    health: () => handler(new Request("http://example.test/healthz")),
  };
}
