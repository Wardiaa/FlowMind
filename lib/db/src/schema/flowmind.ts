import { boolean, index, integer, jsonb, pgTable, text, timestamp, varchar, vector } from "drizzle-orm/pg-core";

export const agentsTable = pgTable("flowmind_agents", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  initials: text("initials").notNull(),
  color: text("color").notNull(),
  status: text("status").notNull(),
  runs: integer("runs").notNull().default(0),
  description: text("description").notNull(),
  tools: text("tools").array().notNull().default([]),
});

export const workflowsTable = pgTable("flowmind_workflows", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(),
  triggerType: text("trigger_type").notNull().default("manual"),
  schedule: text("schedule"),
  webhookToken: text("webhook_token"),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  status: text("status").notNull(),
  runs: integer("runs").notNull().default(0),
  success: text("success").notNull(),
  lastRun: text("last_run").notNull(),
  color: text("color").notNull(),
  steps: text("steps").array().notNull().default([]),
});

export const projectsTable = pgTable("flowmind_projects", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  color: text("color").notNull(),
  progress: integer("progress").notNull().default(0),
  tasks: text("tasks").notNull(),
  owner: text("owner").notNull(),
  due: text("due").notNull(),
  health: text("health").notNull(),
});

export const documentsTable = pgTable("flowmind_documents", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  size: text("size").notNull(),
  date: text("date").notNull(),
  status: text("status").notNull(),
  color: text("color").notNull(),
  objectPath: text("object_path"),
  contentType: text("content_type"),
  extractedText: text("extracted_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentChunksTable = pgTable(
  "flowmind_document_chunks",
  {
    id: varchar("id").primaryKey(),
    ownerId: varchar("owner_id").notNull(),
    documentId: varchar("document_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("IDX_flowmind_document_chunks_owner_document").on(table.ownerId, table.documentId)],
);

export const activityTable = pgTable("flowmind_activity", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  time: text("time").notNull(),
  title: text("title").notNull(),
  action: text("action").notNull(),
  detail: text("detail").notNull(),
  status: text("status").notNull(),
  color: text("color").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const approvalsTable = pgTable("flowmind_approvals", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  agent: text("agent").notNull(),
  title: text("title").notNull(),
  excerpt: text("excerpt").notNull(),
  draft: text("draft").notNull(),
  status: text("status").notNull().default("Pending"),
  executionId: text("execution_id"),
  workflowId: text("workflow_id"),
  stepIndex: integer("step_index"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationsTable = pgTable("flowmind_notifications", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  href: text("href"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentRunsTable = pgTable("flowmind_agent_runs", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  agentId: varchar("agent_id").notNull(),
  prompt: text("prompt").notNull(),
  answer: text("answer"),
  status: text("status").notNull(),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiUsageTable = pgTable("flowmind_ai_usage", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  feature: text("feature").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  latencyMs: integer("latency_ms"),
  refId: text("ref_id"),
  keySource: text("key_source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceSettingsTable = pgTable("flowmind_workspace_settings", {
  ownerId: varchar("owner_id").primaryKey(),
  name: text("name").notNull().default("Northstar"),
  timezone: text("timezone").notNull().default("Africa/Lagos"),
  pauseBeforeExternalActions: boolean("pause_before_external_actions").notNull().default(true),
  showSourceContext: boolean("show_source_context").notNull().default(true),
  dailyDigest: boolean("daily_digest").notNull().default(false),
  geminiApiKeyEnc: text("gemini_api_key_enc"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ExecutionStepKind = "action" | "ai" | "approval";

export type ExecutionStep = {
  name: string;
  kind: ExecutionStepKind;
  status: "pending" | "running" | "completed" | "waiting_approval" | "approved" | "rejected" | "failed";
  startedAt?: string;
  finishedAt?: string;
  output?: string;
};

export const executionsTable = pgTable("flowmind_executions", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  workflowId: varchar("workflow_id").notNull(),
  status: text("status").notNull(),
  triggerSource: text("trigger_source").notNull().default("manual"),
  duration: text("duration").notNull(),
  durationMs: integer("duration_ms"),
  error: text("error"),
  steps: jsonb("steps").$type<ExecutionStep[]>().notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentRecord = typeof agentsTable.$inferSelect;
export type WorkflowRecord = typeof workflowsTable.$inferSelect;
export type ProjectRecord = typeof projectsTable.$inferSelect;
export type DocumentRecord = typeof documentsTable.$inferSelect;
export type DocumentChunkRecord = typeof documentChunksTable.$inferSelect;
export type ActivityRecord = typeof activityTable.$inferSelect;
export type ApprovalRecord = typeof approvalsTable.$inferSelect;
export type NotificationRecord = typeof notificationsTable.$inferSelect;
export type AgentRunRecord = typeof agentRunsTable.$inferSelect;
export type AiUsageRecord = typeof aiUsageTable.$inferSelect;
export type WorkspaceSettings = typeof workspaceSettingsTable.$inferSelect;
export type ExecutionRecord = typeof executionsTable.$inferSelect;
