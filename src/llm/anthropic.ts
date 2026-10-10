import type { LlmClient } from './client';

/** Anthropic Messages API over plain fetch - no SDK needed for one call. */
export class AnthropicLlm implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 20_000,
  ) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for the anthropic provider');
  }

  async complete(req: { system: string; user: string; maxTokens?: number }): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 400,
        temperature: 0,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`);
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error('LLM response had no text block');
    return text;
  }
}
