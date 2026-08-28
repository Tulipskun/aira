import { GoogleGenAI } from "@google/genai";

export interface ContextConfig {
  model?: string;
  apiKey?: string;
}

const DEFAULT_CONFIG: Required<ContextConfig> = {
  model: "gemini-flash-lite-latest",
  apiKey: process.env.GEMINI_API_KEY,
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thought"; signature: string; summary?: string }
  | { type: "function_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "function_result"; call_id: string; name?: string; result: unknown };

type Turn = {
  role: "user" | "model" | "tool";
  content: ContentBlock[];
};

let history: Turn[] = [];

export function createFakeToolInjection(
  toolName: string,
  fakeArgs: Record<string, unknown>,
  data: unknown
): Turn[] {
  const fakeCallId = `injected_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return [
    {
      role: "model",
      content: [{ type: "function_call", id: fakeCallId, name: toolName, args: fakeArgs }],
    },
    {
      role: "tool",
      content: [{ type: "function_result", call_id: fakeCallId, name: toolName, result: data }],
    },
  ];
}

export interface SendMessageOptions {
  tools?: unknown[];
  injectedTurns?: Turn[];
  config?: ContextConfig;
  onToolCall?: (name: string, argsText: string) => Promise<unknown>;
}

type InteractionStep = {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  text?: string;
  summary?: Array<{ type?: string; text?: string }>;
  signature?: string;
};

function responseToTurns(steps: InteractionStep[]): Turn[] {
  return steps.flatMap((step): Turn[] => {
    if (step.type === "function_call") {
      return [{
        role: "model",
        content: [{
          type: "function_call",
          id: step.id ?? `call_${Date.now()}`,
          name: step.name ?? "unknown",
          args: step.arguments ?? {},
        }],
      }];
    }

    if (step.type === "thought") {
      return [{
        role: "model",
        content: [{
          type: "thought",
          signature: step.signature ?? "",
          summary: step.summary?.map((part) => part.text ?? "").filter(Boolean).join("\n"),
        }],
      }];
    }

    if (step.type === "text" && step.text) {
      return [{ role: "model", content: [{ type: "text", text: step.text }] }];
    }

    return [];
  });
}

export async function sendMessage(
  userMessage: string,
  options: SendMessageOptions = {}
): Promise<string> {
  const {
    tools = [],
    injectedTurns = [],
    config = {},
    onToolCall = async () => ({}),
  } = options;

  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const ai = new GoogleGenAI({ apiKey: finalConfig.apiKey });
  const userTurn: Turn = {
    role: "user",
    content: [{ type: "text", text: userMessage }],
  };
  const contextWindow = [...history, ...injectedTurns, userTurn];
  const turnSteps: Turn[] = [...injectedTurns, userTurn];

  let requestInput: unknown = contextWindow;

  for (;;) {
    const response = await ai.interactions.create({
      model: finalConfig.model,
      input: requestInput as never,
      tools,
      store: false,
    });

    const steps = (response.steps ?? []) as InteractionStep[];
    const responseTurns = responseToTurns(steps);
    turnSteps.push(...responseTurns);

    const functionCalls = steps.filter((step) => step.type === "function_call");
    if (!functionCalls.length) {
      const finalText = response.output_text ?? "";
      if (finalText && !responseTurns.some((turn) =>
        turn.content.some((block) => block.type === "text" && block.text === finalText)
      )) {
        turnSteps.push({ role: "model", content: [{ type: "text", text: finalText }] });
      }
      history.push(...turnSteps);
      return finalText;
    }

    const functionResults: Turn[] = [];
    for (const call of functionCalls) {
      const result = await onToolCall(
        call.name ?? "unknown",
        JSON.stringify(call.arguments ?? {})
      );
      functionResults.push({
        role: "tool",
        content: [{
          type: "function_result",
          call_id: call.id ?? "",
          name: call.name,
          result,
        }],
      });
    }

    turnSteps.push(...functionResults);
    requestInput = [...contextWindow, ...responseTurns, ...functionResults];
  }
}
