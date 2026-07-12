import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { config } from "../../lib/config";
import { queryTool } from "../tools/query";
import { retrieveTool } from "../tools/retrieve";

// Ported from reference `rag/agent.py`. Model + verbatim system prompt + both
// tools. LLM_EFFORT maps to the Anthropic provider `effort` option (the AI SDK
// exposes it directly: low | medium | high | xhigh | max); when blank we omit
// it, mirroring the reference's handling for models without effort support.
export const ragAgent = new Agent({
  id: "rag-agent",
  name: "rag-agent",
  instructions: config.SYSTEM_PROMPT,
  model: anthropic(config.LLM_MODEL),
  tools: { query: queryTool, retrieve: retrieveTool },
  defaultOptions: config.LLM_EFFORT
    ? { providerOptions: { anthropic: { effort: config.LLM_EFFORT } } }
    : {},
});
