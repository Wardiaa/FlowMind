import { GoogleGenAI } from "@google/genai";

let queue: Promise<void> = Promise.resolve();

async function runOneAtATime<T>(work: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = queue;
  queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "status" in error ? Number(error.status) : 0;
  return status === 429 || status >= 500;
}

export async function generateGeminiAnswer(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini is not configured. Add GEMINI_API_KEY to workspace Secrets.");
  return runOneAtATime(async () => {
    const client = new GoogleGenAI({ apiKey });
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await client.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: prompt.slice(0, 28_000),
          config: { maxOutputTokens: 8192 },
        });
        const answer = result.text?.trim();
        if (!answer) throw new Error("Gemini returned an empty response.");
        return answer;
      } catch (error) {
        lastError = error;
        if (attempt === 3 || !isRetryable(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      }
    }
    throw lastError;
  });
}