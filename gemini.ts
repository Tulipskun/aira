import { GoogleGenAI } from "@google/genai";

export interface ContextConfig {
  model?: string;
  maxTokens?: number;
  apiKey?: string;
}

const DEFAULT_CONFIG: Required<ContextConfig> = {
  model: "gemini-flash-lite-latest",
  maxTokens: 14000,
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

type TurnPair = {
  turns: Turn[];
};

let history: TurnPair[] = [];

function flatten(pairs: TurnPair[], extraTurns: Turn[] = []): Turn[] {
  const flat: Turn[] = [];
  for (const pair of pairs) flat.push(...pair.turns);
  flat.push(...extraTurns);
  return flat;
}

function toCountableContents(turns: Turn[]) {
  return turns.map((turn) => ({
    role: turn.role,
    parts: turn.content.map((block) => ({
      text: block.type === "text" ? block.text : JSON.stringify(block),
    })),
  }));
}

async function countTokens(
  ai: GoogleGenAI,
  model: string,
  turns: Turn[]
): Promise<number> {
  const response = await ai.models.countTokens({
    model,
    contents: toCountableContents(turns),
  });

  return response.totalTokens;
}

export function createFakeToolInjection(
  toolName: string,
  fakeArgs: Record<string, unknown>,
  data: unknown
): Turn[] {
  const fakeCallId = `injected_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return [
    {
      role: "model",
      content: [
        {
          type: "function_call",
          id: fakeCallId,
          name: toolName,
          args: fakeArgs,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "function_result",
          call_id: fakeCallId,
          name: toolName,
          result: data,
        },
      ],
    },
  ];
}

async function buildContextWindow(
  ai: GoogleGenAI,
  userMessage: string,
  injectedTurns: Turn[] = [],
  config: ContextConfig = {}
): Promise<Turn[]> {
  const finalConfig: Required<ContextConfig> = { ...DEFAULT_CONFIG, ...config };
  const pendingUserTurn: Turn = {
    role: "user",
    content: [{ type: "text", text: userMessage }],
  };
  const extraTurns = [...injectedTurns, pendingUserTurn];

  while (history.length > 0) {
    const candidate = flatten(history, extraTurns);
    const totalTokens = await countTokens(ai, finalConfig.model, candidate);

    if (totalTokens <= finalConfig.maxTokens) break;
    history.shift();
  }

  return flatten(history, extraTurns);
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
  const turns: Turn[] = [];

  for (const step of steps) {
    if (step.type === "function_call") {
      turns.push({
        role: "model",
        content: [
          {
            type: "function_call",
            id: step.id ?? `call_${Date.now()}`,
            name: step.name ?? "unknown",
            args: step.arguments ?? {},
          },
        ],
      });
    } else if (step.type === "thought") {
      turns.push({
        role: "model",
        content: [
          {
            type: "thought",
            signature: step.signature ?? "",
            summary: step.summary
              ?.map((part) => part.text ?? "")
              .filter(Boolean)
              .join("\n"),
          },
        ],
      });
    } else if (step.type === "text" && step.text) {
      turns.push({
        role: "model",
        content: [{ type: "text", text: step.text }],
      });
    }
  }

  return turns;
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

  const finalConfig: Required<ContextConfig> = { ...DEFAULT_CONFIG, ...config };
  const ai = new GoogleGenAI({ apiKey: finalConfig.apiKey });

  const contextWindow = await buildContextWindow(
    ai,
    userMessage,
    injectedTurns,
    finalConfig
  );

  const turnSteps: Turn[] = [
    ...injectedTurns,
    { role: "user", content: [{ type: "text", text: userMessage }] },
  ];

  let requestInput: unknown = contextWindow;
  let finalText = "";

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

    const functionCalls = steps.filter(
      (step) => step.type === "function_call"
    );

    if (functionCalls.length === 0) {
      finalText = response.output_text ?? "";
      break;
    }

    const functionResults: Turn[] = [];

    for (const call of functionCalls) {
      const args = call.arguments ?? {};
      const argsText = JSON.stringify(args);
      const result = await onToolCall(call.name ?? "unknown", argsText);

      functionResults.push({
        role: "tool",
        content: [
          {
            type: "function_result",
            call_id: call.id ?? "",
            name: call.name,
            result,
          },
        ],
      });
    }

    turnSteps.push(...functionResults);
    requestInput = [
      ...contextWindow,
      ...responseTurns,
      ...functionResults,
    ];
  }

  if (finalText) {
    const lastModelText = turnSteps[turnSteps.length - 1];
    const alreadyStored =
      lastModelText?.role === "model" &&
      lastModelText.content.some(
        (block) => block.type === "text" && block.text === finalText
      );

    if (!alreadyStored) {
      turnSteps.push({
        role: "model",
        content: [{ type: "text", text: finalText }],
      });
    }
  }

  history.push({ turns: turnSteps });
  return finalText;
}
