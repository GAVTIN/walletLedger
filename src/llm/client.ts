/**
 * The ONE small interface the rest of the backend talks to. Swap providers
 * (Anthropic, OpenAI, a local model) by writing another class like these.
 * The LLM only ever returns text that our code then parses and validates;
 * it never touches the database and never writes SQL.
 */
export interface LlmClient {
  complete(req: { system: string; user: string; maxTokens?: number }): Promise<string>;
}
