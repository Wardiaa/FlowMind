import { randomUUID } from "crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  activityTable,
  agentRunsTable,
  agentsTable,
  aiUsageTable,
  approvalsTable,
  db,
  documentsTable,
  executionsTable,
  projectsTable,
  workflowsTable,
  workspaceSettingsTable,
} from "@workspace/db";
import {
  AnalyzeProjectParams,
  AnalyzeProjectResponse,
  CreateAgentBody,
  CreateAgentResponse,
  CreateDocumentBody,
  CreateDocumentResponse,
  CreateWorkflowBody,
  CreateWorkflowResponse,
  DecideApprovalBody,
  DecideApprovalParams,
  DecideApprovalResponse,
  DeleteAgentParams,
  DeleteDocumentParams,
  DeleteProjectParams,
  DeleteWorkflowParams,
  GetAiQuotaResponse,
  GetAiUsageQueryParams,
  GetAiUsageResponse,
  GetDashboardResponse,
  DeleteWorkspaceAiKeyResponse,
  GetWorkspaceAiKeyResponse,
  GetWorkspaceSettingsResponse,
  ListActivityResponse,
  ListAgentRunsParams,
  ListAgentRunsResponse,
  ListAgentsResponse,
  ListApprovalsResponse,
  ListDocumentsResponse,
  ListProjectsResponse,
  ListWorkflowExecutionsParams,
  ListWorkflowExecutionsResponse,
  ListWorkflowsResponse,
  RunAgentBody,
  RunAgentParams,
  RunAgentResponse,
  RunCommandCenterBody,
  RunCommandCenterResponse,
  RunWorkflowParams,
  RunWorkflowResponse,
  SearchDocumentsBody,
  SearchDocumentsResponse,
  SeedSampleDataResponse,
  UpdateWorkflowBody,
  UpdateWorkflowParams,
  UpdateWorkflowResponse,
  UpdateWorkspaceAiKeyBody,
  UpdateWorkspaceAiKeyResponse,
  UpdateWorkspaceSettingsBody,
  UpdateWorkspaceSettingsResponse,
} from "@workspace/api-zod";
import type { ExecutionStep, WorkflowRecord } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";
import { CHAT_MODEL, generateGeminiAnswer, streamGeminiAnswer } from "../lib/gemini";
import { getChatBudgetUsage, recordAiUsage, resolveChatDailyLimit } from "../lib/aiUsage";
import { deleteWorkspaceAiKey, getWorkspaceAiKeyState, resolveWorkspaceAiKey, saveWorkspaceAiKey } from "../lib/aiKey";
import { encryptionConfigured } from "../lib/secrets";
import { chunkText } from "../lib/chunking";
import { nextRun } from "../lib/cron";
import { backfillWorkspaceContent, ensureWorkspaceSettings, seedWorkspaceDemoContent } from "../lib/flowmindSeed";
import { createNotification } from "../lib/notify";
import { disableIndexing, indexDocument, searchChunks } from "../lib/retrieval";
import { runCommandCenter } from "../lib/commandTools";
import { applyApprovalDecision, asExecutionSteps, startExecution } from "../lib/workflowEngine";
import { getObjectAclPolicy, ObjectPermission } from "../lib/objectAcl";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();

function owner(req: Request): string {
  if (!req.isAuthenticated()) throw new Error("Sign in is required.");
  return req.user.id;
}

router.use((req, res, next) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Sign in to access this workspace." });
    return;
  }
  next();
});

const backfilledOwners = new Set<string>();

router.use(async (req, res, next) => {
  try {
    const userId = owner(req);
    await ensureWorkspaceSettings(userId);
    if (!backfilledOwners.has(userId)) {
      backfilledOwners.add(userId);
      await backfillWorkspaceContent(userId);
    }
    next();
  } catch (error) {
    next(error);
  }
});

function relativeTime(date: Date): string {
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function activityDto(row: typeof activityTable.$inferSelect) {
  return {
    id: row.id, time: relativeTime(row.createdAt), title: row.title,
    action: row.action, detail: row.detail, status: row.status, color: row.color,
  };
}

function documentDto(row: typeof documentsTable.$inferSelect) {
  return {
    id: row.id, name: row.name, type: row.type, size: row.size,
    date: row.date, status: row.status, color: row.color, objectPath: row.objectPath,
  };
}

function workflowDto(row: typeof workflowsTable.$inferSelect) {
  return {
    id: row.id, name: row.name, trigger: row.trigger,
    triggerType: row.triggerType, schedule: row.schedule, webhookToken: row.webhookToken,
    nextRunAt: row.nextRunAt, lastRunAt: row.lastRunAt,
    status: row.status,
    runs: row.runs, success: row.success, lastRun: row.lastRun, color: row.color, steps: row.steps,
  };
}

function executionDto(row: typeof executionsTable.$inferSelect) {
  return {
    id: row.id, workflowId: row.workflowId, status: row.status,
    triggerSource: row.triggerSource, duration: row.duration, durationMs: row.durationMs,
    error: row.error, steps: asExecutionSteps(row.steps),
    startedAt: row.startedAt, finishedAt: row.finishedAt,
  };
}

function agentRunDto(row: typeof agentRunsTable.$inferSelect, usage?: { inputTokens: number | null; outputTokens: number | null }) {
  return {
    id: row.id, agentId: row.agentId, prompt: row.prompt, answer: row.answer,
    status: row.status, latencyMs: row.latencyMs,
    inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
    createdAt: row.createdAt,
  };
}

async function recordActivity(ownerId: string, event: {
  title: string; action: string; detail: string; status: string; color: string;
}) {
  const [row] = await db.insert(activityTable).values({
    id: randomUUID(), ownerId, time: "Just now", ...event,
  }).returning();
  return row;
}

function fileType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() || "";
  return ({ pdf: "PDF", docx: "DOCX", csv: "CSV", md: "MD", markdown: "MD", json: "JSON", txt: "TXT" } as Record<string, string>)[extension] || extension.toUpperCase();
}

function formatFileSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function extractDocumentText(bytes: Buffer, contentType: string): Promise<string> {
  if (contentType === "application/pdf") {
    // @ts-expect-error - pdf-parse's main entry runs a test file at import time; use the internal module instead.
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    return (await pdfParse(bytes)).text;
  }
  if (contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ buffer: bytes })).value;
  }
  return bytes.toString("utf8");
}

async function fallbackDocumentContext(userId: string): Promise<string> {
  const docs = await db.select({
    name: documentsTable.name,
    text: documentsTable.extractedText,
  }).from(documentsTable).where(and(
    eq(documentsTable.ownerId, userId),
    eq(documentsTable.status, "Processed"),
  )).orderBy(desc(documentsTable.createdAt)).limit(5);
  let remaining = 10_000;
  return docs.map((doc) => {
    const excerpt = (doc.text || "").slice(0, remaining);
    remaining -= excerpt.length;
    return excerpt ? `\n\n[Source: ${doc.name}]\n${excerpt}` : "";
  }).join("");
}

async function buildDocumentContext(userId: string, query: string): Promise<string> {
  const search = await searchChunks(userId, query, 6).catch(() => null);
  if (!search || search.results.length === 0) {
    return fallbackDocumentContext(userId);
  }
  let remaining = 10_000;
  const parts: string[] = [];
  for (const hit of search.results) {
    if (remaining <= 0) break;
    const content = hit.content.slice(0, remaining);
    remaining -= content.length;
    parts.push(`\n\n[Source: ${hit.documentName}]\n${content}`);
  }
  return parts.join("");
}

type AgentSettings = { showSourceContext: boolean | null; pauseBeforeExternalActions: boolean | null };

async function loadAgentSettings(userId: string): Promise<AgentSettings | null> {
  const [settings] = await db.select({
    showSourceContext: workspaceSettingsTable.showSourceContext,
    pauseBeforeExternalActions: workspaceSettingsTable.pauseBeforeExternalActions,
  }).from(workspaceSettingsTable).where(eq(workspaceSettingsTable.ownerId, userId));
  return settings ?? null;
}

function agentPrompt(agent: typeof agentsTable.$inferSelect, settings: AgentSettings | null, context: string, prompt: string): string {
  return `You are FlowMind's ${agent.name}, an AI agent specialized in ${agent.type}.\n` +
    `Instructions: ${agent.description}\nAvailable tools are names only; do not claim to have performed an external action: ${agent.tools.join(", ")}.\n` +
    `Workspace policy: pauseBeforeExternalActions=${settings?.pauseBeforeExternalActions ?? true}. Do not perform or claim external actions; this agent has no connected external services.\n` +
    `Use the following private workspace document excerpts as source context when relevant. If the sources do not answer something, say so.\n${context}\n\nUser request:\n${prompt}`;
}

async function persistAgentRun(input: {
  userId: string;
  agentId: string;
  prompt: string;
  answer: string | null;
  status: "completed" | "failed";
  latencyMs: number | null;
}): Promise<string> {
  const runId = randomUUID();
  await db.insert(agentRunsTable).values({
    id: runId, ownerId: input.userId, agentId: input.agentId,
    prompt: input.prompt, answer: input.answer, status: input.status, latencyMs: input.latencyMs,
  });
  return runId;
}

router.get("/dashboard", async (req, res, next) => {
  try {
    const userId = owner(req);
    const [agents, workflows, activities, projects, pendingApprovals, documentCount] = await Promise.all([
      db.select().from(agentsTable).where(eq(agentsTable.ownerId, userId)),
      db.select().from(workflowsTable).where(eq(workflowsTable.ownerId, userId)),
      db.select().from(activityTable).where(eq(activityTable.ownerId, userId)).orderBy(desc(activityTable.createdAt)).limit(5),
      db.select().from(projectsTable).where(eq(projectsTable.ownerId, userId)).limit(4),
      db.select().from(approvalsTable).where(and(eq(approvalsTable.ownerId, userId), eq(approvalsTable.status, "Pending"))).orderBy(desc(approvalsTable.createdAt)).limit(1),
      db.select({ count: sql<number>`count(*)::int` }).from(documentsTable).where(eq(documentsTable.ownerId, userId)),
    ]);
    const [latestApproval] = pendingApprovals;
    const totalRuns = agents.reduce((sum, agent) => sum + agent.runs, 0) + workflows.reduce((sum, workflow) => sum + workflow.runs, 0);
    const response = {
      metrics: [
        { label: "Active agents", value: String(agents.filter((agent) => agent.status === "Active").length), change: `${agents.length} configured`, trend: "up" },
        { label: "Tasks completed", value: totalRuns.toLocaleString(), change: "Across saved agents and workflows", trend: "up" },
        { label: "Active workflows", value: String(workflows.filter((workflow) => workflow.status === "Active").length), change: `${workflows.length} configured`, trend: "neutral" },
        { label: "Knowledge sources", value: String(documentCount[0]?.count ?? 0), change: "Private to this workspace", trend: "up" },
      ],
      activity: activities.map(activityDto),
      projects,
      approval: {
        id: latestApproval?.id ?? null,
        pending: Boolean(latestApproval),
        agent: latestApproval?.agent ?? "",
        title: latestApproval?.title ?? "",
        excerpt: latestApproval?.excerpt ?? "",
        draft: latestApproval?.draft ?? "",
      },
    };
    res.json(GetDashboardResponse.parse(response));
  } catch (error) {
    next(error);
  }
});

router.get("/agents", async (req, res, next) => {
  try {
    const records = await db.select().from(agentsTable).where(eq(agentsTable.ownerId, owner(req)));
    res.json(ListAgentsResponse.parse(records));
  } catch (error) { next(error); }
});

router.post("/agents", async (req, res, next) => {
  try {
    const userId = owner(req);
    const body = CreateAgentBody.parse(req.body);
    const id = randomUUID();
    const created = {
      id, ownerId: userId, name: body.name.trim(), type: body.type.trim(),
      initials: body.name.trim().split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase(),
      color: "#8b7be8", status: "Draft", runs: 0, description: body.description.trim(),
      tools: ["Search documents", "Draft response"],
    };
    const [row] = await db.insert(agentsTable).values(created).returning();
    res.status(201).json(CreateAgentResponse.parse(row));
  } catch (error) { next(error); }
});

router.delete("/agents/:id", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = DeleteAgentParams.parse(req.params);
    const [agent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, id), eq(agentsTable.ownerId, userId)));
    if (!agent) { res.status(404).json({ error: "Agent not found." }); return; }
    await db.delete(agentRunsTable).where(and(eq(agentRunsTable.ownerId, userId), eq(agentRunsTable.agentId, agent.id)));
    await db.delete(agentsTable).where(and(eq(agentsTable.id, agent.id), eq(agentsTable.ownerId, userId)));
    await recordActivity(userId, {
      title: agent.name, action: "removed agent", detail: agent.description.slice(0, 120),
      status: "Completed", color: agent.color,
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

async function prepareAgentRun(req: Request, res: Response) {
  const userId = owner(req);
  const { id } = RunAgentParams.parse(req.params);
  const body = RunAgentBody.parse(req.body);
  const prompt = body.prompt.trim();
  if (prompt.length > 10_000) {
    res.status(400).json({ error: "Keep prompts under 10,000 characters." });
    return null;
  }
  const [agent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, id), eq(agentsTable.ownerId, userId)));
  if (!agent) {
    res.status(404).json({ error: "Agent not found." });
    return null;
  }
  return { userId, agent, prompt, settings: await loadAgentSettings(userId) };
}

router.post("/agents/:id/run", async (req, res, next) => {
  try {
    const prepared = await prepareAgentRun(req, res);
    if (!prepared) return;
    const { userId, agent, prompt, settings } = prepared;
    const startedAt = Date.now();
    try {
      const personalKey = await resolveWorkspaceAiKey(userId);
      const context = settings?.showSourceContext === false ? "" : await buildDocumentContext(userId, prompt);
      const { answer, usage, latencyMs } = await generateGeminiAnswer(agentPrompt(agent, settings, context, prompt), personalKey);
      const runId = await persistAgentRun({ userId, agentId: agent.id, prompt, answer, status: "completed", latencyMs });
      await recordAiUsage(userId, {
        feature: "agent_run", model: CHAT_MODEL,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs, refId: runId,
        keySource: personalKey ? "workspace" : "server",
      });
      const event = await recordActivity(userId, {
        title: agent.name, action: "completed an AI run", detail: prompt.slice(0, 120),
        status: "Completed", color: agent.color,
      });
      await db.update(agentsTable).set({ runs: agent.runs + 1 }).where(and(eq(agentsTable.id, agent.id), eq(agentsTable.ownerId, userId)));
      res.json(RunAgentResponse.parse({ answer, activityId: event.id, runId }));
    } catch (error) {
      await persistAgentRun({
        userId, agentId: agent.id, prompt, answer: null, status: "failed",
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  } catch (error) { next(error); }
});

router.post("/agents/:id/run/stream", async (req, res, next) => {
  try {
    const prepared = await prepareAgentRun(req, res);
    if (!prepared) return;
    const { userId, agent, prompt, settings } = prepared;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const runId = randomUUID();
    await db.insert(agentRunsTable).values({
      id: runId, ownerId: userId, agentId: agent.id, prompt, answer: null,
      status: "failed", latencyMs: null,
    });
    send("meta", { runId });

    let answer = "";
    const startedAt = Date.now();
    try {
      const personalKey = await resolveWorkspaceAiKey(userId);
      const context = settings?.showSourceContext === false ? "" : await buildDocumentContext(userId, prompt);
      const { usage, latencyMs } = await streamGeminiAnswer(agentPrompt(agent, settings, context, prompt), (delta) => {
        answer += delta;
        send("delta", { text: delta });
      }, personalKey);
      await db.update(agentRunsTable).set({ answer, status: "completed", latencyMs }).where(eq(agentRunsTable.id, runId));
      await recordAiUsage(userId, {
        feature: "agent_run", model: CHAT_MODEL,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs, refId: runId,
        keySource: personalKey ? "workspace" : "server",
      });
      await recordActivity(userId, {
        title: agent.name, action: "completed an AI run", detail: prompt.slice(0, 120),
        status: "Completed", color: agent.color,
      });
      await db.update(agentsTable).set({ runs: agent.runs + 1 }).where(and(eq(agentsTable.id, agent.id), eq(agentsTable.ownerId, userId)));
      send("done", { runId, latencyMs, usage });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The AI run failed.";
      await db.update(agentRunsTable).set({ status: "failed", latencyMs: Date.now() - startedAt }).where(eq(agentRunsTable.id, runId));
      send("error", { message });
    } finally {
      res.end();
    }
  } catch (error) { next(error); }
});

router.get("/agents/:id/runs", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = ListAgentRunsParams.parse(req.params);
    const runs = await db.select().from(agentRunsTable)
      .where(and(eq(agentRunsTable.ownerId, userId), eq(agentRunsTable.agentId, id)))
      .orderBy(desc(agentRunsTable.createdAt)).limit(50);
    const usageRows = runs.length > 0 ? await db.select({
      refId: aiUsageTable.refId,
      inputTokens: aiUsageTable.inputTokens,
      outputTokens: aiUsageTable.outputTokens,
    }).from(aiUsageTable).where(and(
      eq(aiUsageTable.ownerId, userId),
      eq(aiUsageTable.feature, "agent_run"),
      gte(aiUsageTable.createdAt, runs[runs.length - 1].createdAt),
    )) : [];
    const usageByRun = new Map(usageRows.map((row) => [row.refId, row]));
    res.json(ListAgentRunsResponse.parse({
      items: runs.map((run) => agentRunDto(run, usageByRun.get(run.id))),
    }));
  } catch (error) { next(error); }
});

router.get("/workflows", async (req, res, next) => {
  try {
    const rows = await db.select().from(workflowsTable).where(eq(workflowsTable.ownerId, owner(req)));
    res.json(ListWorkflowsResponse.parse(rows.map(workflowDto)));
  } catch (error) { next(error); }
});

function resolveTriggerFields(input: { triggerType?: string; schedule?: string | null }, current: WorkflowRecord) {
  const triggerType = input.triggerType ?? current.triggerType;
  if (triggerType !== "manual" && triggerType !== "schedule" && triggerType !== "webhook") {
    throw Object.assign(new Error("Trigger type must be manual, schedule, or webhook."), { status: 400 });
  }
  const schedule = triggerType === "schedule" ? (input.schedule !== undefined ? input.schedule : current.schedule) : null;
  let nextRunAt: Date | null = null;
  if (triggerType === "schedule") {
    if (!schedule || typeof schedule !== "string") {
      throw Object.assign(new Error("A cron schedule is required for scheduled workflows."), { status: 400 });
    }
    try {
      nextRunAt = nextRun(schedule);
    } catch {
      throw Object.assign(new Error(`"${schedule}" is not a valid cron expression. Use five fields, e.g. "0 9 * * 1".`), { status: 400 });
    }
  }
  return { triggerType, schedule, nextRunAt };
}

router.post("/workflows", async (req, res, next) => {
  try {
    const userId = owner(req);
    const body = CreateWorkflowBody.parse(req.body);
    const draft = {
      id: randomUUID(), ownerId: userId, name: body.name.trim(), trigger: body.trigger.trim(),
      triggerType: body.triggerType ?? "manual", schedule: body.schedule ?? null, webhookToken: null,
      nextRunAt: null, lastRunAt: null,
      status: body.status ?? "Draft", runs: 0, success: "—", lastRun: "Never",
      color: "#55b8a5", steps: body.steps?.length ? body.steps : ["Review the trigger", "Prepare a result", "Pause for human approval"],
    } as WorkflowRecord & { webhookToken: string | null };
    const resolved = resolveTriggerFields(
      { triggerType: draft.triggerType, schedule: draft.schedule },
      { ...draft, triggerType: "manual", schedule: null } as WorkflowRecord,
    );
    const [row] = await db.insert(workflowsTable).values({
      ...draft,
      triggerType: resolved.triggerType,
      schedule: resolved.schedule,
      nextRunAt: resolved.nextRunAt,
      webhookToken: resolved.triggerType === "webhook" ? randomUUID() : null,
    }).returning();
    res.status(201).json(CreateWorkflowResponse.parse(workflowDto(row)));
  } catch (error) { next(error); }
});

router.patch("/workflows/:id", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = UpdateWorkflowParams.parse(req.params);
    const body = UpdateWorkflowBody.parse(req.body);
    const [existing] = await db.select().from(workflowsTable).where(and(eq(workflowsTable.id, id), eq(workflowsTable.ownerId, userId)));
    if (!existing) { res.status(404).json({ error: "Workflow not found." }); return; }
    const resolved = resolveTriggerFields(body, existing);
    const [row] = await db.update(workflowsTable).set({
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.trigger !== undefined ? { trigger: body.trigger.trim() } : {}),
      ...(body.steps !== undefined ? { steps: body.steps } : {}),
      triggerType: resolved.triggerType,
      schedule: resolved.schedule,
      nextRunAt: resolved.nextRunAt,
      ...(resolved.triggerType === "webhook" && !existing.webhookToken ? { webhookToken: randomUUID() } : {}),
      ...(resolved.triggerType !== "webhook" ? { webhookToken: null } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    }).where(and(eq(workflowsTable.id, id), eq(workflowsTable.ownerId, userId))).returning();
    res.json(UpdateWorkflowResponse.parse(workflowDto(row)));
  } catch (error) { next(error); }
});

router.delete("/workflows/:id", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = DeleteWorkflowParams.parse(req.params);
    const [workflow] = await db.select().from(workflowsTable).where(and(eq(workflowsTable.id, id), eq(workflowsTable.ownerId, userId)));
    if (!workflow) { res.status(404).json({ error: "Workflow not found." }); return; }
    // Remove the history too — orphaned executions would leave approvals that
    // crash the decision route when their execution is gone. In-flight engine
    // steps become no-ops (they bail out when the execution row is missing).
    await db.delete(approvalsTable).where(and(eq(approvalsTable.ownerId, userId), eq(approvalsTable.workflowId, workflow.id)));
    await db.delete(executionsTable).where(and(eq(executionsTable.ownerId, userId), eq(executionsTable.workflowId, workflow.id)));
    await db.delete(workflowsTable).where(and(eq(workflowsTable.id, workflow.id), eq(workflowsTable.ownerId, userId)));
    await recordActivity(userId, {
      title: workflow.name, action: "removed workflow", detail: workflow.trigger,
      status: "Completed", color: workflow.color,
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.post("/workflows/:id/run", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = RunWorkflowParams.parse(req.params);
    const [workflow] = await db.select().from(workflowsTable).where(and(eq(workflowsTable.id, id), eq(workflowsTable.ownerId, userId)));
    if (!workflow) { res.status(404).json({ error: "Workflow not found." }); return; }
    if (workflow.status === "Paused") { res.status(409).json({ error: "This workflow is paused. Update its status before running it." }); return; }
    const executionId = await startExecution(workflow, userId, { triggerSource: "manual" });
    const [execution] = await db.select().from(executionsTable).where(eq(executionsTable.id, executionId));
    res.status(202).json(RunWorkflowResponse.parse(executionDto(execution)));
  } catch (error) { next(error); }
});

router.get("/workflows/:id/executions", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = ListWorkflowExecutionsParams.parse(req.params);
    const rows = await db.select().from(executionsTable)
      .where(and(eq(executionsTable.ownerId, userId), eq(executionsTable.workflowId, id)))
      .orderBy(desc(executionsTable.startedAt)).limit(50);
    res.json(ListWorkflowExecutionsResponse.parse({ items: rows.map(executionDto) }));
  } catch (error) { next(error); }
});

router.get("/projects", async (req, res, next) => {
  try {
    const rows = await db.select().from(projectsTable).where(eq(projectsTable.ownerId, owner(req)));
    res.json(ListProjectsResponse.parse(rows));
  } catch (error) { next(error); }
});

router.delete("/projects/:id", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = DeleteProjectParams.parse(req.params);
    const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, id), eq(projectsTable.ownerId, userId)));
    if (!project) { res.status(404).json({ error: "Project not found." }); return; }
    await db.delete(projectsTable).where(and(eq(projectsTable.id, project.id), eq(projectsTable.ownerId, userId)));
    await recordActivity(userId, {
      title: project.name, action: "removed project", detail: `${project.progress}% complete · ${project.tasks} tasks`,
      status: "Completed", color: project.color,
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.post("/projects/:id/analyze", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = AnalyzeProjectParams.parse(req.params);
    const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, id), eq(projectsTable.ownerId, userId)));
    if (!project) { res.status(404).json({ error: "Project not found." }); return; }
    const personalKey = await resolveWorkspaceAiKey(userId);
    const { answer, usage, latencyMs } = await generateGeminiAnswer(
      `Act as a concise project operations analyst. Analyze this workspace project and give: current status, top risks, and 3 practical next steps. Do not invent activity not in the data.\n` +
      JSON.stringify({ name: project.name, progress: project.progress, taskCount: project.tasks, owner: project.owner, due: project.due, health: project.health }),
      personalKey,
    );
    await recordAiUsage(userId, {
      feature: "project_analysis", model: CHAT_MODEL,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs, refId: project.id,
      keySource: personalKey ? "workspace" : "server",
    });
    await recordActivity(userId, { title: "Project Agent", action: "analyzed project", detail: project.name, status: "Insight", color: project.color });
    res.json(AnalyzeProjectResponse.parse({ answer }));
  } catch (error) { next(error); }
});

router.get("/documents", async (req, res, next) => {
  try {
    const rows = await db.select().from(documentsTable).where(eq(documentsTable.ownerId, owner(req))).orderBy(desc(documentsTable.createdAt));
    res.json(ListDocumentsResponse.parse(rows.map(documentDto)));
  } catch (error) { next(error); }
});

router.post("/documents/search", async (req, res, next) => {
  try {
    const userId = owner(req);
    const body = SearchDocumentsBody.parse(req.body);
    if (body.query.trim().length > 2_000) {
      res.status(400).json({ error: "Keep search queries under 2,000 characters." });
      return;
    }
    const search = await searchChunks(userId, body.query.trim(), body.topK ?? 6);
    res.json(SearchDocumentsResponse.parse(search));
  } catch (error) { next(error); }
});

router.post("/documents", async (req, res, next) => {
  try {
    const userId = owner(req);
    const body = CreateDocumentBody.parse(req.body);
    if (!body.objectPath.startsWith("/objects/uploads/") || body.objectPath.split("/").includes("..")) {
      res.status(400).json({ error: "Invalid uploaded object path." });
      return;
    }
    const objectFile = await storage.getObjectEntityFile(body.objectPath);
    const existingPolicy = await getObjectAclPolicy(objectFile);
    if (!existingPolicy) {
      res.status(400).json({ error: "The uploaded file is missing its ownership record." });
      return;
    }
    if (existingPolicy.owner !== userId) {
      res.status(403).json({ error: "That object belongs to another workspace." });
      return;
    }
    const [metadata] = await objectFile.getMetadata();
    if (metadata.size !== body.size || metadata.contentType !== body.contentType) {
      res.status(400).json({ error: "The uploaded file metadata does not match the document." });
      return;
    }
    const bytes = (await objectFile.download())[0];
    const extractedText = (await extractDocumentText(bytes, body.contentType)).trim().slice(0, 100_000);
    if (!extractedText) {
      res.status(422).json({ error: "No readable text was found in this document." });
      return;
    }
    const ext = fileType(body.name);
    const row = {
      id: randomUUID(), ownerId: userId, name: body.name, type: ext,
      size: formatFileSize(body.size), date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
      status: "Processed", color: "#55b8a5", objectPath: body.objectPath,
      contentType: body.contentType, extractedText,
    };
    const [created] = await db.insert(documentsTable).values(row).returning();
    try {
      await indexDocument(userId, created.id, extractedText);
    } catch (error) {
      disableIndexing(error);
    }
    await recordActivity(userId, { title: "Document Agent", action: "processed", detail: body.name, status: "Completed", color: row.color });
    res.status(201).json(CreateDocumentResponse.parse(documentDto(created)));
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "The uploaded object was not found." });
      return;
    }
    next(error);
  }
});

router.delete("/documents/:id", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = DeleteDocumentParams.parse(req.params);
    const [doc] = await db.select().from(documentsTable).where(and(eq(documentsTable.id, id), eq(documentsTable.ownerId, userId)));
    if (!doc) { res.status(404).json({ error: "Document not found." }); return; }
    if (doc.objectPath) {
      const file = await storage.getObjectEntityFile(doc.objectPath);
      const allowed = await storage.canAccessObjectEntity({ userId, objectFile: file, requestedPermission: ObjectPermission.WRITE });
      if (!allowed) { res.status(403).json({ error: "You cannot delete this object." }); return; }
      await file.delete({ ignoreNotFound: true });
    }
    await db.delete(documentsTable).where(and(eq(documentsTable.id, id), eq(documentsTable.ownerId, userId)));
    await recordActivity(userId, { title: "Document Agent", action: "removed document", detail: doc.name, status: "Completed", color: doc.color });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.get("/activity", async (req, res, next) => {
  try {
    const rows = await db.select().from(activityTable).where(eq(activityTable.ownerId, owner(req)))
      .orderBy(desc(activityTable.createdAt)).limit(200);
    res.json(ListActivityResponse.parse(rows.map(activityDto)));
  } catch (error) { next(error); }
});

router.get("/approvals", async (req, res, next) => {
  try {
    const rows = await db.select().from(approvalsTable).where(eq(approvalsTable.ownerId, owner(req)))
      .orderBy(desc(approvalsTable.createdAt)).limit(100);
    res.json(ListApprovalsResponse.parse({
      items: rows.map((row) => ({
        id: row.id, agent: row.agent, title: row.title, excerpt: row.excerpt,
        draft: row.draft, status: row.status,
        executionId: row.executionId, workflowId: row.workflowId, stepIndex: row.stepIndex,
      })),
    }));
  } catch (error) { next(error); }
});

router.patch("/approvals/:id/decision", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = DecideApprovalParams.parse(req.params);
    const body = DecideApprovalBody.parse(req.body);
    const [approval] = await db.update(approvalsTable).set({
      status: body.status,
      ...(body.draft ? { draft: body.draft } : {}),
    }).where(and(eq(approvalsTable.id, id), eq(approvalsTable.ownerId, userId), eq(approvalsTable.status, "Pending"))).returning();
    if (!approval) { res.status(404).json({ error: "Pending approval not found." }); return; }
    await recordActivity(userId, {
      title: approval.agent, action: body.status === "Approved" ? "approved an action" : "rejected an action",
      detail: approval.title, status: body.status, color: "#55b8a5",
    });
    await createNotification(userId, {
      kind: "approval_decision",
      title: `${approval.agent}: ${body.status.toLowerCase()}`,
      body: approval.title,
      href: approval.workflowId ? `/workflows/${approval.workflowId}` : "/approvals",
    });
    await applyApprovalDecision(approval, body.status);
    res.json(DecideApprovalResponse.parse({
      id: approval.id, agent: approval.agent, title: approval.title,
      excerpt: approval.excerpt, draft: approval.draft, status: approval.status,
      executionId: approval.executionId, workflowId: approval.workflowId, stepIndex: approval.stepIndex,
    }));
  } catch (error) { next(error); }
});

router.get("/analytics/ai-usage", async (req, res, next) => {
  try {
    const userId = owner(req);
    const parsed = GetAiUsageQueryParams.parse(req.query);
    const days = parsed.days ?? 14;
    const since = new Date(Date.now() - days * 86_400_000);
    const where = and(eq(aiUsageTable.ownerId, userId), gte(aiUsageTable.createdAt, since));
    const [totals] = await db.select({
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsageTable.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsageTable.outputTokens}), 0)::int`,
    }).from(aiUsageTable).where(where);
    const byFeature = await db.select({
      feature: aiUsageTable.feature,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsageTable.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsageTable.outputTokens}), 0)::int`,
    }).from(aiUsageTable).where(where).groupBy(aiUsageTable.feature);
    const daily = await db.select({
      date: sql<string>`to_char(date_trunc('day', ${aiUsageTable.createdAt}), 'YYYY-MM-DD')`,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsageTable.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsageTable.outputTokens}), 0)::int`,
    }).from(aiUsageTable).where(where)
      .groupBy(sql`date_trunc('day', ${aiUsageTable.createdAt})`)
      .orderBy(sql`date_trunc('day', ${aiUsageTable.createdAt})`);
    res.json(GetAiUsageResponse.parse({
      totals: totals ?? { calls: 0, inputTokens: 0, outputTokens: 0 },
      byFeature,
      daily,
    }));
  } catch (error) { next(error); }
});

router.get("/settings", async (req, res, next) => {
  try {
    const [settings] = await db.select().from(workspaceSettingsTable).where(eq(workspaceSettingsTable.ownerId, owner(req)));
    res.json(GetWorkspaceSettingsResponse.parse(settings));
  } catch (error) { next(error); }
});

router.patch("/settings", async (req, res, next) => {
  try {
    const userId = owner(req);
    const body = UpdateWorkspaceSettingsBody.parse(req.body);
    const [settings] = await db.update(workspaceSettingsTable).set({
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.pauseBeforeExternalActions !== undefined ? { pauseBeforeExternalActions: body.pauseBeforeExternalActions } : {}),
      ...(body.showSourceContext !== undefined ? { showSourceContext: body.showSourceContext } : {}),
      ...(body.dailyDigest !== undefined ? { dailyDigest: body.dailyDigest } : {}),
      ...(body.onboardingCompleted !== undefined ? { onboardingCompleted: body.onboardingCompleted } : {}),
      updatedAt: new Date(),
    }).where(eq(workspaceSettingsTable.ownerId, userId)).returning();
    res.json(UpdateWorkspaceSettingsResponse.parse(settings));
  } catch (error) { next(error); }
});

router.get("/ai-key", async (req, res, next) => {
  try {
    res.json(GetWorkspaceAiKeyResponse.parse(await getWorkspaceAiKeyState(owner(req))));
  } catch (error) { next(error); }
});

router.put("/ai-key", async (req, res, next) => {
  try {
    const body = UpdateWorkspaceAiKeyBody.parse(req.body);
    const key = body.key.trim();
    if (!encryptionConfigured()) {
      res.status(400).json({ error: "Personal AI keys are disabled: the server has no FLOWMIND_ENCRYPTION_KEY configured." });
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      res.status(400).json({ error: "That does not look like a Google AI API key." });
      return;
    }
    res.json(UpdateWorkspaceAiKeyResponse.parse(await saveWorkspaceAiKey(owner(req), key)));
  } catch (error) { next(error); }
});

router.delete("/ai-key", async (req, res, next) => {
  try {
    await deleteWorkspaceAiKey(owner(req));
    res.json(DeleteWorkspaceAiKeyResponse.parse({ configured: false, hint: null }));
  } catch (error) { next(error); }
});

router.get("/ai-quota", async (req, res, next) => {
  try {
    const userId = owner(req);
    const limit = resolveChatDailyLimit();
    let used = 0;
    try {
      used = await getChatBudgetUsage();
    } catch (error) {
      console.error("AI quota read failed", error);
    }
    const keyState = await getWorkspaceAiKeyState(userId);
    res.json(GetAiQuotaResponse.parse({
      used,
      limit,
      remaining: Math.max(0, limit - used),
      exhausted: limit > 0 && used >= limit,
      personalKeyConfigured: keyState.configured,
    }));
  } catch (error) { next(error); }
});

router.post("/sample-data", async (req, res, next) => {
  try {
    const userId = owner(req);
    const seeded = await seedWorkspaceDemoContent(userId);
    if (seeded) {
      // Indexing calls Gemini and can take seconds; documents stay searchable
      // by keyword until chunks exist, so do not block the response on it.
      void backfillWorkspaceContent(userId).catch((error) => {
        req.log.warn({ err: error }, "Sample data indexing failed");
      });
    }
    res.json(SeedSampleDataResponse.parse({ seeded }));
  } catch (error) { next(error); }
});

router.post("/command", async (req, res, next) => {
  try {
    const userId = owner(req);
    const body = RunCommandCenterBody.parse(req.body);
    const prompt = body.prompt.trim();
    if (prompt.length > 10_000) {
      res.status(400).json({ error: "Keep prompts under 10,000 characters." });
      return;
    }
    const personalKey = await resolveWorkspaceAiKey(userId);
    const { answer, toolCalls } = await runCommandCenter(userId, prompt, personalKey);
    await recordActivity(userId, { title: "Command center", action: "answered a question", detail: prompt.slice(0, 120), status: "Insight", color: "#55b8a5" });
    res.json(RunCommandCenterResponse.parse({ answer, toolCalls }));
  } catch (error) { next(error); }
});

export default router;
