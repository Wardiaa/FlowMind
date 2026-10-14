import { createPartFromFunctionResponse, Type, type Content, type Part, type Tool } from "@google/genai";
import { desc, eq } from "drizzle-orm";
import { activityTable, agentsTable, approvalsTable, db, projectsTable, workflowsTable } from "@workspace/db";
import { CHAT_MODEL, generateGeminiTurn } from "./gemini";
import { recordAiUsage } from "./aiUsage";
import { searchChunks } from "./retrieval";

export type CommandToolCall = {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  documents?: string[];
};

const MAX_TOOL_ITERATIONS = 4;

const TOOL_DECLARATIONS: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "list_projects",
        description: "List the workspace projects with their health, progress, and due dates.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "list_workflows",
        description: "List the workspace automation workflows with their trigger type, status, and run totals.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "list_agents",
        description: "List the workspace AI agents with their specialty, status, and run totals.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "list_pending_approvals",
        description: "List approvals that are still waiting for a human decision.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "get_recent_activity",
        description: "Get the most recent workspace activity events.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "search_documents",
        description: "Semantic search over the workspace private documents. Use this for any question about document contents.",
        parameters: {
          type: Type.OBJECT,
          properties: { query: { type: Type.STRING, description: "The search query." } },
          required: ["query"],
        },
      },
    ],
  },
];

type ToolOutcome = { summary: string; documents?: string[] };

async function executeTool(ownerId: string, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  switch (name) {
    case "list_projects": {
      const rows = await db.select({
        name: projectsTable.name, code: projectsTable.code, health: projectsTable.health,
        progress: projectsTable.progress, due: projectsTable.due,
      }).from(projectsTable).where(eq(projectsTable.ownerId, ownerId));
      return { summary: JSON.stringify(rows) };
    }
    case "list_workflows": {
      const rows = await db.select({
        name: workflowsTable.name, triggerType: workflowsTable.triggerType, trigger: workflowsTable.trigger,
        status: workflowsTable.status, runs: workflowsTable.runs,
      }).from(workflowsTable).where(eq(workflowsTable.ownerId, ownerId));
      return { summary: JSON.stringify(rows) };
    }
    case "list_agents": {
      const rows = await db.select({
        name: agentsTable.name, type: agentsTable.type, status: agentsTable.status, runs: agentsTable.runs,
      }).from(agentsTable).where(eq(agentsTable.ownerId, ownerId));
      return { summary: JSON.stringify(rows) };
    }
    case "list_pending_approvals": {
      const rows = await db.select({
        agent: approvalsTable.agent, title: approvalsTable.title, excerpt: approvalsTable.excerpt,
      }).from(approvalsTable).where(eq(approvalsTable.ownerId, ownerId)).limit(10);
      const pending = rows;
      return { summary: pending.length > 0 ? JSON.stringify(pending) : "No pending approvals." };
    }
    case "get_recent_activity": {
      const rows = await db.select({
        title: activityTable.title, action: activityTable.action, detail: activityTable.detail,
        createdAt: activityTable.createdAt,
      }).from(activityTable).where(eq(activityTable.ownerId, ownerId))
        .orderBy(desc(activityTable.createdAt)).limit(15);
      return { summary: JSON.stringify(rows) };
    }
    case "search_documents": {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) return { summary: "A non-empty query is required." };
      const search = await searchChunks(ownerId, query, 5);
      if (search.results.length === 0) return { summary: "No matching documents were found." };
      return {
        summary: JSON.stringify(search.results.map((hit) => ({
          document: hit.documentName,
          score: Number(hit.score.toFixed(3)),
          excerpt: hit.content.slice(0, 500),
        }))),
        documents: [...new Set(search.results.map((hit) => hit.documentName))],
      };
    }
    default:
      return { summary: `Unknown tool "${name}".` };
  }
}

export async function runCommandCenter(
  ownerId: string,
  prompt: string,
): Promise<{ answer: string; toolCalls: CommandToolCall[] }> {
  const system =
    "You are FlowMind's workspace command center. Answer questions about this workspace using the provided tools. " +
    "Call the tools you need, then answer concisely based on their results. If the tools do not answer something, say so. " +
    "Never claim to trigger external actions.";
  const contents: Content[] = [{ role: "user", parts: [{ text: `${system}\n\nUser question:\n${prompt}` }] }];
  const toolCalls: CommandToolCall[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const turn = await generateGeminiTurn(contents, TOOL_DECLARATIONS);
    await recordAiUsage(ownerId, {
      feature: "command",
      model: CHAT_MODEL,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      latencyMs: turn.latencyMs,
    });
    if (turn.functionCalls.length === 0) {
      return { answer: turn.text ?? "", toolCalls };
    }
    // Gemini 3 requires the model turn's original parts (thought signatures on
    // functionCall parts included) to be echoed back verbatim in tool loops.
    contents.push({ role: "model", parts: turn.parts });
    const parts: Part[] = [];
    for (const [index, call] of turn.functionCalls.entries()) {
      // gemini-3 models sometimes emit [] or a scalar for no-param calls; the
      // response contract requires a plain object per tool call.
      const rawArgs = call.args;
      const args = (rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? rawArgs
        : {}) as Record<string, unknown>;
      const outcome = await executeTool(ownerId, call.name ?? "", args);
      toolCalls.push({
        tool: call.name ?? "unknown",
        args,
        summary: outcome.summary.slice(0, 500),
        ...(outcome.documents ? { documents: outcome.documents } : {}),
      });
      parts.push(createPartFromFunctionResponse(String(index), call.name ?? "unknown", { result: outcome.summary.slice(0, 2_000) }));
    }
    contents.push({ role: "user", parts });
  }

  // The model kept requesting tools; take away the tools and force a final answer.
  const final = await generateGeminiTurn(contents, []);
  await recordAiUsage(ownerId, {
    feature: "command",
    model: CHAT_MODEL,
    inputTokens: final.usage.inputTokens,
    outputTokens: final.usage.outputTokens,
    latencyMs: final.latencyMs,
  });
  return { answer: final.text ?? "", toolCalls };
}
