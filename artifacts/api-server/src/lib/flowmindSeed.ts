import { db, activityTable, agentsTable, approvalsTable, documentsTable, projectsTable, workflowsTable, workspaceSettingsTable } from "@workspace/db";

export async function ensureWorkspaceSeeded(ownerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [created] = await tx.insert(workspaceSettingsTable)
      .values({ ownerId })
      .onConflictDoNothing()
      .returning({ ownerId: workspaceSettingsTable.ownerId });
    if (!created) return;

    const id = (key: string) => `${ownerId}:${key}`;
    await tx.insert(agentsTable).values([
      { id: id("agent-communication"), ownerId, name: "Communication Agent", type: "Customer operations", initials: "CO", color: "#ed806f", status: "Active", runs: 248, description: "Classifies inbound requests and drafts thoughtful replies.", tools: ["Search knowledge", "Draft response", "Create task"] },
      { id: id("agent-document"), ownerId, name: "Document Agent", type: "Knowledge & compliance", initials: "DO", color: "#8b7be8", status: "Active", runs: 186, description: "Extracts key details from contracts, briefs, and reports.", tools: ["Search documents", "Extract data", "Generate report"] },
      { id: id("agent-marketing"), ownerId, name: "Marketing Agent", type: "Growth", initials: "MA", color: "#69bda4", status: "Active", runs: 94, description: "Turns a campaign brief into ready-to-review content.", tools: ["Create campaign", "Generate copy", "Send notification"] },
      { id: id("agent-project"), ownerId, name: "Project Agent", type: "Delivery", initials: "PA", color: "#6491d5", status: "Paused", runs: 76, description: "Surfaces risks and keeps project work moving forward.", tools: ["Create task", "Update task", "Analyze project"] },
      { id: id("agent-analytics"), ownerId, name: "Analytics Agent", type: "Business intelligence", initials: "AN", color: "#d0a13b", status: "Active", runs: 61, description: "Answers questions about operational data in plain language.", tools: ["Analyze CSV", "Explain trend", "Generate report"] },
    ]);

    await tx.insert(workflowsTable).values([
      { id: id("workflow-complaints"), ownerId, name: "Customer Complaint Handler", trigger: "New customer email", status: "Active", runs: 184, success: "98.4%", lastRun: "2 min ago", color: "#ed806f", steps: ["Capture incoming complaint", "Classify urgency and sentiment", "Draft a response with source context", "Request human approval when risk is high"] },
      { id: id("workflow-contracts"), ownerId, name: "Contract Review & Routing", trigger: "New document uploaded", status: "Active", runs: 68, success: "100%", lastRun: "18 min ago", color: "#8b7be8", steps: ["Read the uploaded contract", "Extract renewal date and key terms", "Create a review summary"] },
      { id: id("workflow-digest"), ownerId, name: "Weekly Project Digest", trigger: "Every Monday at 09:00", status: "Active", runs: 42, success: "97.6%", lastRun: "Yesterday", color: "#6491d5", steps: ["Collect project updates", "Summarize blockers", "Prepare a review digest"] },
      { id: id("workflow-campaign"), ownerId, name: "Campaign Approval Loop", trigger: "Manual trigger", status: "Draft", runs: 12, success: "91.7%", lastRun: "Sep 26", color: "#69bda4", steps: ["Review campaign brief", "Draft campaign copy", "Request human approval"] },
    ]);

    await tx.insert(projectsTable).values([
      { id: id("project-cx"), ownerId, name: "Customer Experience", code: "CX", color: "#ed806f", progress: 72, tasks: "18 / 25", owner: "AM", due: "Oct 18", health: "On track" },
      { id: id("project-web"), ownerId, name: "Website Redesign", code: "WR", color: "#8b7be8", progress: 48, tasks: "12 / 26", owner: "JS", due: "Nov 02", health: "At risk" },
      { id: id("project-growth"), ownerId, name: "Q4 Growth Campaign", code: "Q4", color: "#69bda4", progress: 31, tasks: "8 / 24", owner: "TK", due: "Nov 28", health: "On track" },
    ]);

    await tx.insert(documentsTable).values([
      { id: id("doc-vendor"), ownerId, name: "vendor-renewal-2026.pdf", type: "PDF", size: "2.4 MB", date: "Sep 30, 2026", status: "Processed", color: "#ed806f", objectPath: null, contentType: null, extractedText: null },
      { id: id("doc-faq"), ownerId, name: "customer-support-faq.pdf", type: "PDF", size: "840 KB", date: "Sep 29, 2026", status: "Processed", color: "#8b7be8", objectPath: null, contentType: null, extractedText: null },
      { id: id("doc-catalog"), ownerId, name: "product-catalog.csv", type: "CSV", size: "128 KB", date: "Sep 28, 2026", status: "Processing", color: "#69bda4", objectPath: null, contentType: null, extractedText: null },
      { id: id("doc-brief"), ownerId, name: "q3-campaign-brief.docx", type: "DOCX", size: "1.1 MB", date: "Sep 27, 2026", status: "Processed", color: "#6491d5", objectPath: null, contentType: null, extractedText: null },
    ]);

    const now = Date.now();
    await tx.insert(activityTable).values([
      { id: id("activity-1"), ownerId, time: "2m ago", title: "Communication Agent", action: "prepared a reply for approval", detail: "Enterprise onboarding request", status: "Waiting", color: "#8b7be8", createdAt: new Date(now - 2 * 60_000) },
      { id: id("activity-2"), ownerId, time: "18m ago", title: "Document Agent", action: "processed", detail: "vendor-renewal-2026.pdf", status: "Completed", color: "#6491d5", createdAt: new Date(now - 18 * 60_000) },
      { id: id("activity-3"), ownerId, time: "42m ago", title: "Customer Complaint Handler", action: "completed workflow", detail: "6 steps · 4.2s duration", status: "Completed", color: "#69bda4", createdAt: new Date(now - 42 * 60_000) },
      { id: id("activity-4"), ownerId, time: "1h ago", title: "Website Redesign", action: "was updated", detail: "2 tasks moved to In progress", status: "Completed", color: "#ed806f", createdAt: new Date(now - 60 * 60_000) },
      { id: id("activity-5"), ownerId, time: "2h ago", title: "Analytics Agent", action: "found a trend", detail: "Support volume up 18% this week", status: "Insight", color: "#d0a13b", createdAt: new Date(now - 2 * 60 * 60_000) },
    ]);

    await tx.insert(approvalsTable).values({
      id: id("approval-onboarding"),
      ownerId,
      agent: "Communication Agent",
      title: "Enterprise onboarding request",
      excerpt: "The customer requested onboarding help for a new enterprise workspace.",
      draft: "Hi Daniela, thanks for reaching out. I’ve attached our onboarding guide and asked the team to prioritize your workspace setup. Please let us know if you have a preferred launch date.",
      status: "Pending",
      createdAt: new Date(now - 2 * 60_000),
    });
  });
}