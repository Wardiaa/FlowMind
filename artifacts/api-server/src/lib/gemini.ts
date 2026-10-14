import { GoogleGenAI, type Content, type FunctionCall, type Part, type Tool } from "@google/genai";

export const CHAT_MODEL = "gemini-3-flash-preview";
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

const MAX_CONCURRENCY = 2;

let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini is not configured. Add GEMINI_API_KEY to workspace Secrets.");
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

export type GeminiUsage = { inputTokens: number; outputTokens: number };

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "status" in error ? Number(error.status) : 0;
  return status === 429 || status >= 500;
}

async function withRetries<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw lastError;
}

export async function generateGeminiAnswer(
  prompt: string,
): Promise<{ answer: string; usage: GeminiUsage; latencyMs: number }> {
  const ai = getClient();
  const startedAt = Date.now();
  await acquire();
  try {
    const result = await withRetries(() =>
      ai.models.generateContent({
        model: CHAT_MODEL,
        contents: prompt.slice(0, 28_000),
        config: { maxOutputTokens: 8192 },
      }),
    );
    const answer = result.text?.trim();
    if (!answer) throw new Error("Gemini returned an empty response.");
    return {
      answer,
      usage: {
        inputTokens: result.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: result.usageMetadata?.candidatesTokenCount ?? 0,
      },
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    release();
  }
}

export async function streamGeminiAnswer(
  prompt: string,
  onDelta: (text: string) => void,
): Promise<{ usage: GeminiUsage; latencyMs: number }> {
  const ai = getClient();
  const startedAt = Date.now();
  await acquire();
  try {
    let usage: GeminiUsage = { inputTokens: 0, outputTokens: 0 };
    let sentAny = false;
    const run = async (): Promise<void> => {
      sentAny = false;
      const stream = await ai.models.generateContentStream({
        model: CHAT_MODEL,
        contents: prompt.slice(0, 28_000),
        config: { maxOutputTokens: 8192 },
      });
      for await (const chunk of stream) {
        if (chunk.text) {
          sentAny = true;
          onDelta(chunk.text);
        }
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? usage.inputTokens,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens,
          };
        }
      }
      if (!sentAny) throw new Error("Gemini returned an empty response.");
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await run();
        return { usage, latencyMs: Date.now() - startedAt };
      } catch (error) {
        lastError = error;
        if (attempt === 3 || !isRetryable(error) || sentAny) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      }
    }
    throw lastError;
  } finally {
    release();
  }
}

export async function generateGeminiTurn(
  contents: Content[],
  tools: Tool[],
): Promise<{ text: string | null; functionCalls: FunctionCall[]; parts: Part[]; usage: GeminiUsage; latencyMs: number }> {
  const ai = getClient();
  const startedAt = Date.now();
  await acquire();
  try {
    const result = await withRetries(() =>
      ai.models.generateContent({
        model: CHAT_MODEL,
        contents,
        config: { maxOutputTokens: 8192, ...(tools.length > 0 ? { tools } : {}) },
      }),
    );
    const text = result.text?.trim() ?? null;
    const functionCalls = result.functionCalls ?? [];
    if (!text && functionCalls.length === 0) throw new Error("Gemini returned an empty response.");
    return {
      text,
      functionCalls,
      parts: result.candidates?.[0]?.content?.parts ?? [],
      usage: {
        inputTokens: result.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: result.usageMetadata?.candidatesTokenCount ?? 0,
      },
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    release();
  }
}

export async function embedTexts(texts: string[]): Promise<{ embeddings: number[][]; totalTokens: number }> {
  if (texts.length === 0) return { embeddings: [], totalTokens: 0 };
  const ai = getClient();
  const embeddings: number[][] = [];
  let totalTokens = 0;
  const batchSize = 100;
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize).map((text) => text.slice(0, 8_000));
    await acquire();
    try {
      const result = await withRetries(() =>
        ai.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: batch,
          config: { outputDimensionality: EMBEDDING_DIMENSIONS },
        }),
      );
      const values = result.embeddings?.map((embedding) => embedding.values ?? []);
      if (!values || values.length !== batch.length) {
        throw new Error("Gemini embeddings returned an unexpected shape.");
      }
      embeddings.push(...values);
      totalTokens += Math.ceil(batch.join("").length / 4);
    } finally {
      release();
    }
  }
  return { embeddings, totalTokens };
}
