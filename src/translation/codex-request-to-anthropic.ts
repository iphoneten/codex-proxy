/**
 * Translate CodexResponsesRequest → Anthropic Messages API request body.
 *
 * Key differences from Codex/OpenAI:
 *   - System prompt is a top-level `system` field (not inline message)
 *   - Tool call results use `tool_result` content type (not `role: "tool"`)
 *   - Tool calls in assistant turns use `tool_use` content type
 *   - `thinking` budget maps to extended thinking params
 *   - Images use `source` with base64 or URL (different from OpenAI)
 */

import type { CodexInputItem, CodexContentPart, CodexResponsesRequest } from "../proxy/codex-types.js";
import { codexToolChoiceToAnthropic } from "./tool-format.js";

/** Anthropic content block shapes. */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessageRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  stream: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: { type: "enabled"; budget_tokens: number };
}

function codexPartToAnthropic(part: CodexContentPart): AnthropicContentBlock {
  if (part.type === "input_text") {
    return { type: "text", text: part.text };
  }
  // input_image — pass as URL source
  return { type: "image", source: { type: "url", url: part.image_url } };
}

function extractInstructionText(
  content: string | CodexContentPart[],
): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<CodexContentPart, { type: "input_text" }> => part.type === "input_text")
    .map((part) => part.text)
    .join("\n");
}

function inputItemsToAnthropicMessages(input: CodexInputItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  for (const item of input) {
    if ("role" in item) {
      const role = item.role as string;
      if (role === "system" || role === "developer") continue; // handled via top-level system field

      const oaiRole = role as "user" | "assistant";
      if (typeof item.content === "string") {
        messages.push({ role: oaiRole, content: item.content });
      } else {
        messages.push({ role: oaiRole, content: item.content.map(codexPartToAnthropic) });
      }
    } else if (item.type === "function_call") {
      // Merge into preceding assistant message or create new one
      const toolUse: AnthropicContentBlock = {
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: (() => {
          try { return JSON.parse(item.arguments) as unknown; } catch { return {}; }
        })(),
      };
      const last = messages.at(-1);
      if (last?.role === "assistant" && Array.isArray(last.content)) {
        last.content.push(toolUse);
      } else {
        messages.push({ role: "assistant", content: [toolUse] });
      }
    } else if (item.type === "function_call_output") {
      const toolResult: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: item.call_id,
        content: item.output,
      };
      // tool_result must be inside a user message
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(toolResult);
      } else {
        messages.push({ role: "user", content: [toolResult] });
      }
    }
  }

  return messages;
}

function extractAdditionalSystemInstructions(input: CodexInputItem[]): string {
  const parts: string[] = [];
  for (const item of input) {
    if (!("role" in item)) continue;
    const role = item.role as string;
    if (role !== "system" && role !== "developer") continue;
    const text = extractInstructionText(item.content).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

const REASONING_EFFORT_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 8192,
  high: 16000,
  xhigh: 32000,
};

export function translateCodexToAnthropicRequest(
  req: CodexResponsesRequest,
  modelId: string,
): AnthropicMessageRequest {
  const messages = inputItemsToAnthropicMessages(req.input);
  const additionalSystem = extractAdditionalSystemInstructions(req.input);

  const body: AnthropicMessageRequest = {
    model: modelId,
    messages,
    max_tokens: 8192,
    stream: req.stream,
  };

  const systemText = [req.instructions?.trim(), additionalSystem].filter(Boolean).join("\n\n");
  if (systemText) {
    body.system = systemText;
  }

  // Thinking budget for extended reasoning
  if (req.reasoning?.effort) {
    const budget = REASONING_EFFORT_BUDGET[req.reasoning.effort] ?? 8192;
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  if (req.tools?.length) {
    body.tools = req.tools;
    if (req.tool_choice !== undefined) {
      const toolChoice = codexToolChoiceToAnthropic(req.tool_choice);
      if (toolChoice) body.tool_choice = toolChoice;
    }
  }

  return body;
}
