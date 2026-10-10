import type { Config } from '../config';
import { AnthropicLlm } from './anthropic';
import type { LlmClient } from './client';
import { heuristicHandler, MockLlm } from './mock';

export function createLlm(cfg: Config): LlmClient {
  if (cfg.llmProvider === 'anthropic') return new AnthropicLlm(cfg.anthropicApiKey, cfg.llmModel);
  return new MockLlm(heuristicHandler);
}
