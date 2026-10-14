import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  activityTable,
  approvalsTable,
  db,
  executionsTable,
  workflowsTable,
  type ApprovalRecord,
  type ExecutionStep,
  type WorkflowRecord,
} from "@workspace/db";
import { CHAT_MODEL, generateGeminiAnswer } from "./gemini";
import { recordAiUsage } from "./aiUsage";
import { resolveWorkspaceAiKey } from "./aiKey";
import { createNotification } from "./notify";

type TriggerSource = "manual" | "schedule" | "webhook";

export function stepKind(label: string): ExecutionStep["kind"] {
  const lower = label.trim().toLowerCase();
  if (lower.startsWith("ai:")) return "ai";
  if (lower.startsWith("approval:") || lower.startsWith("approve:")) return "approval";
  if (lower === "pause for human approval") return "approval";
  return "action";
}

function stepLabel(label: string): string {
  const stripped = label.replace(/^(ai|approval|approve)\s*:\s*/i, "").trim();
  return stripped || label.trim();
}

export function buildSteps(labels: string[]): ExecutionStep[] {
  return labels.map((name) => ({ name, kind: stepKind(name), status: "pending" as const }));
}

// Execution rows written before structured steps only hold plain strings.
export function asExecutionSteps(value: unknown): ExecutionStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) =>
    typeof item === "string"
      ? { name: item, kind: stepKind(item), status: "completed" as const }
      : (item as ExecutionStep),
  );
}

async function persistSteps(executionId: string, steps: ExecutionStep[]): Promise<void> {
  await db.update(executionsTable).set({ steps }).where(eq(executionsTable.id, executionId));
}

export async function startExecution(
  workflow: WorkflowRecord,
  ownerId: string,
  options: { triggerSource: TriggerSource; webhookInput?: unknown },
): Promise<string> {
  const executionId = randomUUID();
  const steps = buildSteps(workflow.steps);
  await db.insert(executionsTable).values({
    id: executionId,
    ownerId,
    workflowId: workflow.id,
    status: "Running",
    triggerSource: options.triggerSource,
    duration: "—",
    durationMs: null,
    steps,
    startedAt: new Date(),
  });
  void runSteps(executionId, ownerId, workflow, steps, 0, options.webhookInput).catch(async (error) => {
    await failExecution(executionId, error instanceof Error ? error.message : String(error));
  });
  return executionId;
}

async function runSteps(
  executionId: string,
  ownerId: string,
  workflow: WorkflowRecord,
  steps: ExecutionStep[],
  fromIndex: number,
  webhookInput?: unknown,
): Promise<void> {
  // Resolve the workspace's personal key once per execution so resumed and
  // scheduled runs pick up key changes.
  const personalKey = await resolveWorkspaceAiKey(ownerId);
  for (let index = fromIndex; index < steps.length; index++) {
    const step = steps[index];
    step.startedAt = new Date().toISOString();

    if (step.kind === "approval") {
      step.status = "waiting_approval";
      await persistSteps(executionId, steps);
      await db.update(executionsTable).set({ status: "Waiting" }).where(eq(executionsTable.id, executionId));
      await db.insert(approvalsTable).values({
        id: randomUUID(),
        ownerId,
        agent: workflow.name,
        title: stepLabel(step.name),
        excerpt: `Workflow "${workflow.name}" paused at step ${index + 1} of ${steps.length}.`,
        draft: `Approve to let "${workflow.name}" continue with its remaining steps.`,
        status: "Pending",
        executionId,
        workflowId: workflow.id,
        stepIndex: index,
      });
      await createNotification(ownerId, {
        kind: "approval_pending",
        title: `${workflow.name} needs approval`,
        body: stepLabel(step.name),
        href: "/approvals",
      });
      return;
    }

    step.status = "running";
    await persistSteps(executionId, steps);

    if (step.kind === "ai") {
      const inputJson = webhookInput === undefined || webhookInput === null
        ? ""
        : `\nTrigger input data (may be empty):\n${JSON.stringify(webhookInput).slice(0, 2_000)}`;
      const { answer, usage, latencyMs } = await generateGeminiAnswer(
        `You are a step inside the FlowMind workflow "${workflow.name}". Its configured trigger is: ${workflow.trigger}.\n` +
        `Perform only this step and return only its result text:\n${stepLabel(step.name)}${inputJson}`,
        personalKey,
      );
      step.output = answer;
      await recordAiUsage(ownerId, {
        feature: "workflow_ai",
        model: CHAT_MODEL,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs,
        refId: executionId,
        keySource: personalKey ? "workspace" : "server",
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 150));
      step.output = "Done";
    }
    step.status = "completed";
    step.finishedAt = new Date().toISOString();
    await persistSteps(executionId, steps);
  }
  await finalizeExecution(executionId, "Completed");
}

function summarizeError(error: string | undefined): string {
  if (!error) return "Unknown error";
  try {
    const parsed = JSON.parse(error) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON — use as-is
  }
  return error.slice(0, 200);
}

async function finalizeExecution(executionId: string, status: "Completed" | "Failed", error?: string): Promise<void> {
  const [execution] = await db.select().from(executionsTable).where(eq(executionsTable.id, executionId));
  if (!execution) return;
  const [workflow] = await db.select().from(workflowsTable).where(eq(workflowsTable.id, execution.workflowId));
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - execution.startedAt.getTime());
  await db.update(executionsTable).set({
    status,
    finishedAt,
    durationMs,
    duration: `${(durationMs / 1000).toFixed(1)}s`,
    ...(error !== undefined ? { error } : {}),
  }).where(eq(executionsTable.id, executionId));
  if (!workflow) return;

  const [stats] = await db.select({
    total: sql<number>`count(*)::int`,
    completed: sql<number>`count(*) filter (where status = 'Completed')::int`,
  }).from(executionsTable).where(
    and(eq(executionsTable.ownerId, execution.ownerId), eq(executionsTable.workflowId, workflow.id)),
  );
  const successText = stats && stats.total > 0 ? `${Math.round((stats.completed / stats.total) * 1000) / 10}%` : "—";
  await db.update(workflowsTable).set({
    runs: workflow.runs + 1,
    lastRun: "Just now",
    lastRunAt: finishedAt,
    success: successText,
  }).where(eq(workflowsTable.id, workflow.id));

  if (status === "Failed") {
    const detail = summarizeError(error);
    await db.insert(activityTable).values({
      id: randomUUID(), ownerId: execution.ownerId, time: "Just now",
      title: workflow.name, action: "failed workflow run",
      detail, status: "Failed", color: "#ed806f",
    });
    await createNotification(execution.ownerId, {
      kind: "run_failed",
      title: `${workflow.name} run failed`,
      body: detail,
      href: `/workflows/${workflow.id}`,
    });
    return;
  }

  await db.insert(activityTable).values({
    id: randomUUID(), ownerId: execution.ownerId, time: "Just now",
    title: workflow.name, action: "completed workflow",
    detail: `${execution.triggerSource} trigger · ${(durationMs / 1000).toFixed(1)}s`,
    status: "Completed", color: workflow.color,
  });
  if (execution.triggerSource !== "manual") {
    await createNotification(execution.ownerId, {
      kind: "run_completed",
      title: `${workflow.name} finished`,
      body: `${execution.triggerSource} run completed in ${(durationMs / 1000).toFixed(1)}s`,
      href: `/workflows/${workflow.id}`,
    });
  }
}

export async function failExecution(executionId: string, error: string): Promise<void> {
  await finalizeExecution(executionId, "Failed", error);
}

export async function applyApprovalDecision(approval: ApprovalRecord, decision: "Approved" | "Rejected"): Promise<void> {
  if (!approval.executionId || approval.stepIndex === null) return;
  const [execution] = await db.select().from(executionsTable).where(eq(executionsTable.id, approval.executionId));
  if (!execution) return;
  const steps = asExecutionSteps(execution.steps);
  const step = steps[approval.stepIndex];
  if (step) {
    step.status = decision === "Approved" ? "approved" : "rejected";
    step.finishedAt = new Date().toISOString();
    await db.update(executionsTable).set({ steps }).where(eq(executionsTable.id, execution.id));
  }
  if (decision === "Rejected") {
    await finalizeExecution(execution.id, "Failed", `Approval rejected: ${approval.title}`);
    return;
  }
  if (execution.status !== "Waiting") return;
  const [workflow] = await db.select().from(workflowsTable).where(eq(workflowsTable.id, execution.workflowId));
  if (!workflow) return;
  await db.update(executionsTable).set({ status: "Running" }).where(eq(executionsTable.id, execution.id));
  void runSteps(execution.id, execution.ownerId, workflow, steps, approval.stepIndex + 1, undefined).catch(
    async (error) => {
      await failExecution(execution.id, error instanceof Error ? error.message : String(error));
    },
  );
}
