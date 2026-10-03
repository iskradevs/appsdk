import { IskraClient } from "@iskra/apps";

export async function runAction(
  raw: Record<string, unknown>,
  apiUrl: string,
  token: string,
  idempotencyKey: string,
) {
  const message = typeof raw.message === "string" ? raw.message : "Продолжи задачу";
  const conversationID = typeof raw.conversation_id === "string" ? raw.conversation_id : undefined;
  const inputs =
    typeof raw.inputs === "object" && raw.inputs !== null
      ? (raw.inputs as Record<string, unknown>)
      : undefined;
  const client = new IskraClient({ apiUrl, token });
  return client.run(
    {
      message,
      ...(conversationID === undefined ? {} : { conversation_id: conversationID }),
      ...(inputs === undefined ? {} : { policy: { inputs } }),
    },
    { idempotencyKey },
  );
}
