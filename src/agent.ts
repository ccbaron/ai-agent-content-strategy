import { gemini } from "./gemini/client.js";
import { config } from "./config.js";
import { evaluateResponse } from "./evaluator.js";
import {
  getBaseGenerationConfig,
  getToolEnabledGenerationConfig,
} from "./gemini/generation-config.js";
import { createTaskPlan } from "./planner.js";
import { systemPrompt } from "./prompts.js";
import { executeFunctionCall, functionDeclarations } from "./tools/index.js";

type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentStreamEvent =
  | {
      type: "status";
      phase:
        | "planning"
        | "tool_call"
        | "evaluating"
        | "revising"
        | "generating";
      message: string;
    }
  | {
      type: "tool";
      toolName: string;
    }
  | {
      type: "chunk";
      text: string;
    }
  | {
      type: "done";
    };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiresInternalContext(userMessage: string): boolean {
  const normalized = userMessage.toLowerCase();

  const internalContextSignals = [
    "our positioning",
    "our brand",
    "our tone",
    "our strategy",
    "our messaging",
    "our audience",
    "our voice",
    "brand voice",
    "tone of voice",
    "internal knowledge",
  ];

  return internalContextSignals.some((signal) => normalized.includes(signal));
}

export class ContentIntelligenceAgent {
  private conversationHistory: ConversationMessage[];

  constructor() {
    this.conversationHistory = [];
  }

  async reply(userMessage: string): Promise<string> {
    const taskPlan = await createTaskPlan(userMessage);

    const planningContext = `
Task type: ${taskPlan.taskType}
Should research: ${taskPlan.shouldResearch}
Response goal: ${taskPlan.responseGoal}
Preferred output format: ${taskPlan.outputFormat}
    `.trim();

    const shouldEnableTools =
      taskPlan.shouldResearch ||
      taskPlan.taskType === "comparison" ||
      taskPlan.taskType === "research" ||
      requiresInternalContext(userMessage);

    const recentHistory = this.conversationHistory.slice(
      -config.MAX_CONVERSATION_MESSAGES,
    );

    const contents: Array<{
      role: "user" | "model";
      parts: Array<Record<string, unknown>>;
    }> = [
      ...recentHistory.map((message) => ({
        role:
          message.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: message.content }],
      })),
      {
        role: "user",
        parts: [
          {
            text: `${systemPrompt}

User request:
${userMessage}

Planning context:
${planningContext}`,
          },
        ],
      },
    ];

    const generationConfig = shouldEnableTools
      ? getToolEnabledGenerationConfig()
      : getBaseGenerationConfig();

    let finalText = "";
    let toolIterations = 0;
    const maxToolIterations = 5;

    while (true) {
      if (toolIterations > maxToolIterations) {
        throw new Error("Agent exceeded maximum tool call iterations.");
      }

      const response = await gemini.models.generateContent({
        model: config.GEMINI_MODEL,
        contents,
        config: generationConfig,
      });

      const functionCalls = response.functionCalls ?? [];

      if (functionCalls.length > 0) {
        const functionCall = functionCalls[0];

        if (!functionCall.name) {
          throw new Error("Gemini returned a function call without a name.");
        }

        toolIterations++;

        const toolResult = await executeFunctionCall({
          id: functionCall.id,
          name: functionCall.name,
          args: functionCall.args ?? {},
        });

        contents.push({
          role: "model",
          parts: [{ functionCall }],
        });

        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: functionCall.name,
                response: { result: toolResult },
                id: functionCall.id,
              },
            },
          ],
        });

        continue;
      }

      finalText = response.text || "I could not generate a response.";
      break;
    }

    const shouldEvaluate =
      config.EVALUATOR_ENABLED &&
      (taskPlan.shouldResearch ||
        taskPlan.taskType === "comparison" ||
        finalText.length > 500);

    const evaluation = shouldEvaluate
      ? await evaluateResponse({
          userMessage,
          responseText: finalText,
          taskType: taskPlan.taskType,
          shouldResearch: taskPlan.shouldResearch,
        })
      : {
          shouldRevise: false,
          revisionReason: "",
          strengths: [],
          weaknesses: [],
        };

    let assistantMessage = finalText;

    if (evaluation.shouldRevise) {
      const revisionResponse = await gemini.models.generateContent({
        model: config.GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `
${systemPrompt}

Original user request:
${userMessage}

Initial response:
${assistantMessage}

Revision reason:
${evaluation.revisionReason}

Known weaknesses:
${evaluation.weaknesses.join("; ")}

Please produce a stronger final answer that better satisfies the request.
                `.trim(),
              },
            ],
          },
        ],
        config: getBaseGenerationConfig(),
      });

      assistantMessage = revisionResponse.text || assistantMessage;
    }

    this.conversationHistory.push({
      role: "user",
      content: userMessage,
    });

    this.conversationHistory.push({
      role: "assistant",
      content: assistantMessage,
    });

    return assistantMessage;
  }

  async replyWithEvents(
    userMessage: string,
    onEvent: (event: AgentStreamEvent) => Promise<void> | void,
  ): Promise<string> {
    await onEvent({
      type: "status",
      phase: "planning",
      message: "Planning task...",
    });

    const taskPlan = await createTaskPlan(userMessage);

    const planningContext = `
Task type: ${taskPlan.taskType}
Should research: ${taskPlan.shouldResearch}
Response goal: ${taskPlan.responseGoal}
Preferred output format: ${taskPlan.outputFormat}
    `.trim();

    const shouldEnableTools =
      taskPlan.shouldResearch ||
      taskPlan.taskType === "comparison" ||
      taskPlan.taskType === "research" ||
      requiresInternalContext(userMessage);

    const recentHistory = this.conversationHistory.slice(
      -config.MAX_CONVERSATION_MESSAGES,
    );

    const contents: Array<{
      role: "user" | "model";
      parts: Array<Record<string, unknown>>;
    }> = [
      ...recentHistory.map((message) => ({
        role:
          message.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: message.content }],
      })),
      {
        role: "user",
        parts: [
          {
            text: `${systemPrompt}

User request:
${userMessage}

Planning context:
${planningContext}`,
          },
        ],
      },
    ];

    const generationConfig = shouldEnableTools
      ? getToolEnabledGenerationConfig()
      : getBaseGenerationConfig();

    let finalText = "";
    let toolIterations = 0;
    const maxToolIterations = 5;

    while (true) {
      if (toolIterations > maxToolIterations) {
        throw new Error("Agent exceeded maximum tool call iterations.");
      }

      await onEvent({
        type: "status",
        phase: "generating",
        message: shouldEnableTools
          ? "Generating response and checking tools..."
          : "Generating response...",
      });

      const response = await gemini.models.generateContent({
        model: config.GEMINI_MODEL,
        contents,
        config: generationConfig,
      });

      const functionCalls = response.functionCalls ?? [];

      if (functionCalls.length > 0) {
        const functionCall = functionCalls[0];

        if (!functionCall.name) {
          throw new Error("Gemini returned a function call without a name.");
        }

        toolIterations++;

        await onEvent({
          type: "status",
          phase: "tool_call",
          message: `Using tool: ${functionCall.name}`,
        });

        await onEvent({
          type: "tool",
          toolName: functionCall.name,
        });

        const toolResult = await executeFunctionCall({
          id: functionCall.id,
          name: functionCall.name,
          args: functionCall.args ?? {},
        });

        contents.push({
          role: "model",
          parts: [{ functionCall }],
        });

        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: functionCall.name,
                response: { result: toolResult },
                id: functionCall.id,
              },
            },
          ],
        });

        continue;
      }

      finalText = response.text || "I could not generate a response.";
      break;
    }

    const shouldEvaluate =
      config.EVALUATOR_ENABLED &&
      (taskPlan.shouldResearch ||
        taskPlan.taskType === "comparison" ||
        finalText.length > 500);

    let assistantMessage = finalText;

    if (shouldEvaluate) {
      await onEvent({
        type: "status",
        phase: "evaluating",
        message: "Evaluating answer quality...",
      });

      const evaluation = await evaluateResponse({
        userMessage,
        responseText: finalText,
        taskType: taskPlan.taskType,
        shouldResearch: taskPlan.shouldResearch,
      });

      if (evaluation.shouldRevise) {
        await onEvent({
          type: "status",
          phase: "revising",
          message: "Revising answer...",
        });

        const revisionResponse = await gemini.models.generateContent({
          model: config.GEMINI_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `
${systemPrompt}

Original user request:
${userMessage}

Initial response:
${assistantMessage}

Revision reason:
${evaluation.revisionReason}

Known weaknesses:
${evaluation.weaknesses.join("; ")}

Please produce a stronger final answer that better satisfies the request.
                  `.trim(),
                },
              ],
            },
          ],
          config: getBaseGenerationConfig(),
        });

        assistantMessage = revisionResponse.text || assistantMessage;
      }
    }

    const chunkSize = 24;
    for (let index = 0; index < assistantMessage.length; index += chunkSize) {
      const chunk = assistantMessage.slice(index, index + chunkSize);
      await onEvent({
        type: "chunk",
        text: chunk,
      });
      await delay(12);
    }

    this.conversationHistory.push({
      role: "user",
      content: userMessage,
    });

    this.conversationHistory.push({
      role: "assistant",
      content: assistantMessage,
    });

    await onEvent({
      type: "done",
    });

    return assistantMessage;
  }

  clearMemory(): void {
    this.conversationHistory = [];
  }
}
