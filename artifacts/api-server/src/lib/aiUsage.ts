import { randomUUID } from "crypto";
import { and, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import { aiUsageTable, db } from "@workspace/db";

export type AiFeature = "agent_run" | "command" | "project_analysis" | "workflow_ai" | "embedding";

export class AiBudgetExceededError extends Error {
  status = 429;
  expose = true;
  constructor(message: string) {
    super(message);
    this.name = "AiBudgetExceededError";
  }
}

// Free-tier request limits are per model and per day. The default matches the
// default chat model's generous flash-lite bucket; lower it if you switch
// GEMINI_CHAT_MODEL to a small-quota preview model (~20/day).
const DEFAULT_CHAT_DAILY_LIMIT = 1000;

export function resolveChatDailyLimit(): number {
  const raw = process.env.GEMINI_DAILY_REQUEST_LIMIT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CHAT_DAILY_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_CHAT_DAILY_LIMIT;
  return parsed;
}

// Counts recorded chat calls that used the server-level key (embeddings use a
// separate model quota; personal workspace keys have their own Google quota) over
// a rolling 24h window, across all owners.
export async function getChatBudgetUsage(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiUsageTable)
    .where(
      and(
        ne(aiUsageTable.feature, "embedding"),
        or(isNull(aiUsageTable.keySource), eq(aiUsageTable.keySource, "server")),
        gte(aiUsageTable.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

export async function assertChatBudget(): Promise<void> {
  const limit = resolveChatDailyLimit();
  if (limit === 0) return;
  try {
    const count = await getChatBudgetUsage();
    if (count >= limit) {
      throw new AiBudgetExceededError(
        `Daily AI request limit reached (${count}/${limit} requests in the last 24 hours). ` +
          "The window resets automatically, add a personal Gemini API key in Settings, or raise GEMINI_DAILY_REQUEST_LIMIT.",
      );
    }
  } catch (error) {
    if (error instanceof AiBudgetExceededError) throw error;
    // The ledger is a soft guard; availability beats strictness on check errors.
    console.error("AI budget check failed; allowing request", error);
  }
}

export async function recordAiUsage(
  ownerId: string,
  entry: {
    feature: AiFeature;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs?: number | null;
    refId?: string | null;
    keySource?: "server" | "workspace" | null;
  },
): Promise<void> {
  try {
    await db.insert(aiUsageTable).values({
      id: randomUUID(),
      ownerId,
      feature: entry.feature,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      latencyMs: entry.latencyMs ?? null,
      refId: entry.refId ?? null,
      keySource: entry.keySource ?? null,
    });
  } catch (error) {
    console.error("Failed to record AI usage", error);
  }
}
