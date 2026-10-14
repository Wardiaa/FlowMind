import { randomUUID } from "crypto";
import { aiUsageTable, db } from "@workspace/db";

export type AiFeature = "agent_run" | "command" | "project_analysis" | "workflow_ai" | "embedding";

export async function recordAiUsage(
  ownerId: string,
  entry: {
    feature: AiFeature;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs?: number | null;
    refId?: string | null;
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
    });
  } catch (error) {
    console.error("Failed to record AI usage", error);
  }
}
