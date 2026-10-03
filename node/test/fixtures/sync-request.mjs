import { IskraClient } from "../../dist/index.js";

const { input, idempotencyKey } = JSON.parse(process.argv[2]);
const client = new IskraClient({
  apiUrl: "http://iskra-api",
  token: "viewer.jwt",
  fetch: async (url, init) => {
    process.stdout.write(JSON.stringify({ method: init.method, url, headers: init.headers, body: init.body }));
    return Response.json({
      conversation_id: "fixture",
      status: "completed",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  },
});
await client.run(input, { idempotencyKey });
