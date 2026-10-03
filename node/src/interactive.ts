// Типы ниже зеркалируют native Headless Chat API без переименования wire-полей:
// приложение может безопасно передать interaction обратно своему UI.
export interface InteractionInput {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
}

export interface HeadlessInteraction {
  readonly tool_call_id: string;
  readonly inputs: readonly InteractionInput[];
}

export interface HeadlessUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface HeadlessArtifact {
  readonly name: string;
  readonly download_url?: string;
}

interface HeadlessResponseBase {
  readonly conversation_id: string;
  readonly message_id?: string;
  readonly usage: HeadlessUsage;
  readonly expires_at?: string;
}

export interface HeadlessCompletedResponse<TOutput = unknown> extends HeadlessResponseBase {
  readonly status: "completed";
  readonly answer?: string;
  readonly reasoning?: string;
  readonly files?: readonly HeadlessArtifact[];
  readonly output?: TOutput;
  readonly interaction?: never;
}

export interface HeadlessInteractionRequiredResponse extends HeadlessResponseBase {
  readonly status: "interaction_required";
  readonly interaction: HeadlessInteraction;
  readonly answer?: never;
  readonly output?: never;
}

export type HeadlessResponse<TOutput = unknown> =
  | HeadlessCompletedResponse<TOutput>
  | HeadlessInteractionRequiredResponse;

export function isInteractionRequired(
  value: unknown,
): value is HeadlessInteractionRequiredResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "interaction_required") return false;
  if (typeof candidate.conversation_id !== "string") return false;
  if (typeof candidate.usage !== "object" || candidate.usage === null) return false;
  const usage = candidate.usage as Record<string, unknown>;
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number")
    return false;
  if (typeof candidate.interaction !== "object" || candidate.interaction === null) return false;
  const interaction = candidate.interaction as Record<string, unknown>;
  return (
    typeof interaction.tool_call_id === "string" &&
    Array.isArray(interaction.inputs) &&
    interaction.inputs.every(isInteractionInput)
  );
}

function isInteractionInput(value: unknown): value is InteractionInput {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.name === "string" &&
    typeof input.label === "string" &&
    typeof input.type === "string" &&
    typeof input.required === "boolean"
  );
}
