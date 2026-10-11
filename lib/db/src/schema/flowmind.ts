import { boolean, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceSettingsTable = pgTable("flowmind_workspace_settings", {
  ownerId: varchar("owner_id").primaryKey(),
  name: text("name").notNull().default("Northstar"),
  timezone: text("timezone").notNull().default("Africa/Lagos"),
  pauseBeforeExternalActions: boolean("pause_before_external_actions").notNull().default(true),
  showSourceContext: boolean("show_source_context").notNull().default(true),
  dailyDigest: boolean("daily_digest").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const executionsTable = pgTable("flowmind_executions", {
  id: varchar("id").primaryKey(),
  ownerId: varchar("owner_id").notNull(),
  workflowId: varchar("workflow_id").notNull(),
  status: text("status").notNull(),
  duration: text("duration").notNull(),
  steps: jsonb("steps").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentRecord = typeof agentsTable.$inferSelect;
export type WorkflowRecord = typeof workflowsTable.$inferSelect;
export type ProjectRecord = typeof projectsTable.$inferSelect;
export type DocumentRecord = typeof documentsTable.$inferSelect;
export type ActivityRecord = typeof activityTable.$inferSelect;
export type ApprovalRecord = typeof approvalsTable.$inferSelect;
export type WorkspaceSettings = typeof workspaceSettingsTable.$inferSelect;
export type ExecutionRecord = typeof executionsTable.$inferSelect;