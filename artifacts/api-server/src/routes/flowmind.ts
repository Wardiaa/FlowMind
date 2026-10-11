import { randomUUID } from "crypto";
import { db, activityTable, agentsTable, approvalsTable, documentsTable, executionsTable, projectsTable, workflowsTable, workspaceSettingsTable } from "@workspace/db";
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
  DeleteDocumentParams,
  GetDashboardResponse,
  GetWorkspaceSettingsResponse,
  ListActivityResponse,
  ListAgentsResponse,
  ListDocumentsResponse,
  ListProjectsResponse,
  ListWorkflowsResponse,
  RunAgentBody,
  RunAgentParams,
  RunAgentResponse,
  RunCommandCenterBody,
  RunCommandCenterResponse,
  RunWorkflowParams,
  RunWorkflowResponse,
  UpdateWorkflowBody,
  UpdateWorkflowParams,
  UpdateWorkflowResponse,
  UpdateWorkspaceSettingsBody,
  UpdateWorkspaceSettingsResponse,
} from "@workspace/api-zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { ensureWorkspaceSeeded } from "../lib/flowmindSeed";
import { generateGeminiAnswer } from "../lib/gemini";
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

router.use(async (req, res, next) => {
  try {
    await ensureWorkspaceSeeded(owner(req));
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
    id: row.id, name: row.name, trigger: row.trigger, status: row.status,
    runs: row.runs, success: row.success, lastRun: row.lastRun, color: row.color, steps: row.steps,
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

router.post("/agents/:id/run", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = RunAgentParams.parse(req.params);
    const body = RunAgentBody.parse(req.body);
    if (body.prompt.trim().length > 10_000) {
      res.status(400).json({ error: "Keep prompts under 10,000 characters." });
      return;
    }
    const [agent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, id), eq(agentsTable.ownerId, userId)));
    if (!agent) { res.status(404).json({ error: "Agent not found." }); return; }
    const [settings] = await db.select({
      showSourceContext: workspaceSettingsTable.showSourceContext,
      pauseBeforeExternalActions: workspaceSettingsTable.pauseBeforeExternalActions,
    }).from(workspaceSettingsTable).where(eq(workspaceSettingsTable.ownerId, userId));
    const docs = settings?.showSourceContext ? await db.select({
      name: documentsTable.name,
      text: documentsTable.extractedText,
    }).from(documentsTable).where(and(
      eq(documentsTable.ownerId, userId),
      eq(documentsTable.status, "Processed"),
    )).orderBy(desc(documentsTable.createdAt)).limit(5) : [];
    let remaining = 10_000;
    const context = docs.map((doc) => {
      const excerpt = (doc.text || "").slice(0, remaining);
      remaining -= excerpt.length;
      return excerpt ? `\n\n[Source: ${doc.name}]\n${excerpt}` : "";
    }).join("");
    const answer = await generateGeminiAnswer(
      `You are FlowMind's ${agent.name}, an AI agent specialized in ${agent.type}.\n` +
      `Instructions: ${agent.description}\nAvailable tools are names only; do not claim to have performed an external action: ${agent.tools.join(", ")}.\n` +
      `Workspace policy: pauseBeforeExternalActions=${settings?.pauseBeforeExternalActions ?? true}. Do not perform or claim external actions; this agent has no connected external services.\n` +
      `Use the following private workspace document excerpts as source context when relevant. If the sources do not answer something, say so.\n${context}\n\nUser request:\n${body.prompt.trim()}`,
    );
    const event = await recordActivity(userId, {
      title: agent.name, action: "completed an AI run", detail: body.prompt.trim().slice(0, 120),
      status: "Completed", color: agent.color,
    });
    await db.update(agentsTable).set({ runs: agent.runs + 1 }).where(and(eq(agentsTable.id, id), eq(agentsTable.ownerId, userId)));
    res.json(RunAgentResponse.parse({ answer, activityId: event.id }));
  } catch (error) { next(error); }
});

router.get("/workflows", async (req, res, next) => {
  try {
    const rows = await db.select().from(workflowsTable).where(eq(workflowsTable.ownerId, owner(req)));
    res.json(ListWorkflowsResponse.parse(rows.map(workflowDto)));
  } catch (error) { next(error); }
});

router.post("/workflows", async (req, res, next) => {
  try {
    const userId = owner(req);
    const body = CreateWorkflowBody.parse(req.body);
    const [row] = await db.insert(workflowsTable).values({
      id: randomUUID(), ownerId: userId, name: body.name.trim(), trigger: body.trigger.trim(),
      status: body.status ?? "Draft", runs: 0, success: "—", lastRun: "Never",
      color: "#55b8a5", steps: body.steps?.length ? body.steps : ["Review the trigger", "Prepare a result", "Pause for human approval"],
    }).returning();
    res.status(201).json(CreateWorkflowResponse.parse(workflowDto(row)));
  } catch (error) { next(error); }
});

router.patch("/workflows/:id", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = UpdateWorkflowParams.parse(req.params);
    const body = UpdateWorkflowBody.parse(req.body);
    const [row] = await db.update(workflowsTable).set({
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.trigger !== undefined ? { trigger: body.trigger.trim() } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.steps !== undefined ? { steps: body.steps } : {}),
    }).where(and(eq(workflowsTable.id, id), eq(workflowsTable.ownerId, userId))).returning();
    if (!row) { res.status(404).json({ error: "Workflow not found." }); return; }
    res.json(UpdateWorkflowResponse.parse(workflowDto(row)));
  } catch (error) { next(error); }
});

router.post("/workflows/:id/run", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = RunWorkflowParams.parse(req.params);
    const [workflow] = await db.select().from(workflowsTable).where(and(eq(workflowsTable.id, id), eq(workflowsTable.ownerId, userId)));
    if (!workflow) { res.status(404).json({ error: "Workflow not found." }); return; }
    if (workflow.status === "Paused") { res.status(409).json({ error: "This workflow is paused. Update its status before running it." }); return; }
    const executionId = randomUUID();
    const duration = "0.2s";
    await db.insert(executionsTable).values({
      id: executionId, ownerId: userId, workflowId: id, status: "Completed", duration, steps: workflow.steps,
    });
    await db.update(workflowsTable).set({
      runs: workflow.runs + 1, lastRun: "Just now",
    }).where(and(eq(workflowsTable.id, id), eq(workflowsTable.ownerId, userId)));
    await recordActivity(userId, {
      title: workflow.name, action: "completed workflow test",
      detail: `${workflow.steps.length} configured steps · ${duration}`,
      status: "Completed", color: workflow.color,
    });
    res.json(RunWorkflowResponse.parse({ id: executionId, workflowId: id, status: "Completed", duration, steps: workflow.steps }));
  } catch (error) { next(error); }
});

router.get("/projects", async (req, res, next) => {
  try {
    const rows = await db.select().from(projectsTable).where(eq(projectsTable.ownerId, owner(req)));
    res.json(ListProjectsResponse.parse(rows));
  } catch (error) { next(error); }
});

router.post("/projects/:id/analyze", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = AnalyzeProjectParams.parse(req.params);
    const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, id), eq(projectsTable.ownerId, userId)));
    if (!project) { res.status(404).json({ error: "Project not found." }); return; }
    const answer = await generateGeminiAnswer(
      `Act as a concise project operations analyst. Analyze this workspace project and give: current status, top risks, and 3 practical next steps. Do not invent activity not in the data.\n` +
      JSON.stringify({ name: project.name, progress: project.progress, taskCount: project.tasks, owner: project.owner, due: project.due, health: project.health }),
    );
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
    res.json(DecideApprovalResponse.parse({
      id: approval.id, agent: approval.agent, title: approval.title,
      excerpt: approval.excerpt, draft: approval.draft, status: approval.status,
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
      updatedAt: new Date(),
    }).where(eq(workspaceSettingsTable.ownerId, userId)).returning();
    res.json(UpdateWorkspaceSettingsResponse.parse(settings));
  } catch (error) { next(error); }
});

router.post("/command", async (req, res, next) => {
  try {
    const userId = owner(req);
    const body = RunCommandCenterBody.parse(req.body);
    if (body.prompt.trim().length > 10_000) {
      res.status(400).json({ error: "Keep prompts under 10,000 characters." });
      return;
    }
    const [agents, workflows, projects, approvals] = await Promise.all([
      db.select({ name: agentsTable.name, status: agentsTable.status, runs: agentsTable.runs }).from(agentsTable).where(eq(agentsTable.ownerId, userId)),
      db.select({ name: workflowsTable.name, status: workflowsTable.status, runs: workflowsTable.runs }).from(workflowsTable).where(eq(workflowsTable.ownerId, userId)),
      db.select({ name: projectsTable.name, health: projectsTable.health, progress: projectsTable.progress, due: projectsTable.due }).from(projectsTable).where(eq(projectsTable.ownerId, userId)),
      db.select({ title: approvalsTable.title, agent: approvalsTable.agent, status: approvalsTable.status }).from(approvalsTable).where(eq(approvalsTable.ownerId, userId)).limit(10),
    ]);
    const answer = await generateGeminiAnswer(
      `You are FlowMind's workspace command center. Answer based only on this workspace data. Be clear about unknowns, and never claim to trigger external actions.\n` +
      `Workspace data: ${JSON.stringify({ agents, workflows, projects, approvals })}\n\nUser request:\n${body.prompt.trim()}`,
    );
    await recordActivity(userId, { title: "Command center", action: "answered a question", detail: body.prompt.trim().slice(0, 120), status: "Insight", color: "#55b8a5" });
    res.json(RunCommandCenterResponse.parse({ answer }));
  } catch (error) { next(error); }
});

export default router;