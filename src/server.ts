import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { join } from "node:path";
import { z } from "zod";
import { ContentIntelligenceAgent } from "./agent.js";
import { config, logConfiguredServices } from "./config.js";

const app = express();
const agent = new ContentIntelligenceAgent();

const frontendDir = join(process.cwd(), "frontend");

const streamQuerySchema = z.object({
  message: z.string().trim().min(1, "Message is required.").max(4000),
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please try again later.",
  },
});

function sendBadRequest(
  res: express.Response,
  message: string,
  details?: unknown,
): void {
  res.status(400).json({
    error: message,
    ...(details ? { details } : {}),
  });
}

function classifyApiError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("resource exhausted") ||
    message.includes("too many requests")
  ) {
    return "The model is currently busy. Please wait a moment and try again.";
  }

  return "Something went wrong. Please try again.";
}

function writeSseEvent(
  res: express.Response,
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);
app.use(cors());
app.use("/api", apiLimiter);
app.use(express.static(frontendDir));

app.get("/", (_req, res) => {
  res.sendFile(join(frontendDir, "index.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    app: "content-intelligence-agent",
    model: config.GEMINI_MODEL,
    mode: config.APP_MODE,
  });
});

app.get("/api/chat/stream", async (req, res) => {
  const parsed = streamQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    sendBadRequest(res, "Invalid query parameters.", parsed.error.flatten());
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  res.flushHeaders?.();

  const keepAlive = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    res.end();
  });

  try {
    await agent.replyWithEvents(parsed.data.message, async (event) => {
      switch (event.type) {
        case "status":
          writeSseEvent(res, "status", {
            phase: event.phase,
            message: event.message,
          });
          break;

        case "tool":
          writeSseEvent(res, "tool", {
            toolName: event.toolName,
          });
          break;

        case "chunk":
          writeSseEvent(res, "chunk", {
            text: event.text,
          });
          break;

        case "done":
          writeSseEvent(res, "done", {
            success: true,
          });
          break;
      }
    });
  } catch (error) {
    console.error("Streaming chat endpoint error:", error);

    writeSseEvent(res, "error", {
      message: classifyApiError(error),
    });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

app.post("/api/reset", (_req, res) => {
  agent.clearMemory();

  res.json({
    success: true,
    message: "Conversation memory cleared.",
  });
});

logConfiguredServices();

app.listen(config.PORT, () => {
  console.log(`Web server running at http://localhost:${config.PORT}`);
});
