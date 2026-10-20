import { randomUUID } from "crypto";
import {
  activityTable,
  agentsTable,
  approvalsTable,
  db,
  documentChunksTable,
  documentsTable,
  projectsTable,
  workflowsTable,
  workspaceSettingsTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { disableIndexing, indexDocument } from "./retrieval";
import { nextRun } from "./cron";

const SEED_DOCUMENT_TEXT: Record<string, string> = {
  "doc-vendor": `Cloudline Vendor Agreement — Renewal Summary 2026.
Contract parties: Northstar Ltd (Customer) and Cloudline Systems Inc (Vendor). Contract term: 12 months from October 1, 2026 through September 30, 2027.
Renewal window: The agreement renews automatically unless cancelled in writing at least 60 days before the term end date, so the cancellation deadline is August 1, 2027.
Pricing: The monthly platform fee is $4,800 for up to 250 seats, with overage billed at $19 per additional seat. A 5 percent annual uplift applies at each renewal.
Support commitments: Vendor provides 24x5 support with a 4-hour response SLA for Severity 1 incidents and 1 business day for Severity 2. Credits of 10 percent of the monthly fee apply for each missed Severity 1 SLA, capped at 30 percent.
Data processing: All customer data remains stored in the United States. Vendor subprocessors must be listed 30 days before onboarding. Breach notification is due within 48 hours.
Termination: Either party may terminate for material breach with 30 days cure period. On termination the vendor exports customer data in CSV format within 15 days at no charge.`,
  "doc-faq": `Northstar Customer Support FAQ.
Q: How do I reset my workspace password? A: Use the Forgot password link on the sign-in page. Workspace admins can also force a reset from the Members panel.
Q: Can I invite guests outside my company? A: Yes. Guests get access only to projects they are explicitly added to, and their activity is labeled in the audit log.
Q: Where are my documents stored? A: Documents upload to private, encrypted storage scoped to your workspace. Only workspace members can download them.
Q: What file types can I upload? A: PDF, DOCX, TXT, Markdown, CSV, and JSON up to 25 MB per file. Larger files should be split before upload.
Q: How do billing overages work? A: Overage seats are prorated daily and appear on the next invoice. You can cap spending from the Billing settings page.
Q: Can I export my data? A: Workspace owners can request a full export (projects, tasks, and documents) from Settings. Exports are prepared within 24 hours and delivered by download link.
Q: What is the refund policy? A: Annual plans can be refunded pro-rata within 30 days of purchase. Monthly plans are not refunded but can be cancelled any time.`,
  "doc-catalog": `sku,product_name,category,unit_price,stock,reorder_level
CL-100,Cloudline Basic Seat,Licence,49.00,820,200
CL-200,Cloudline Pro Seat,Licence,89.00,540,150
CL-300,Cloudline Enterprise Seat,Licence,159.00,310,100
HW-010,Edge Gateway Mini,Hardware,249.00,64,25
HW-020,Edge Gateway Pro,Hardware,549.00,38,15
HW-030,Sensor Pack (10x),Hardware,129.00,142,40
AC-005,Mounting Kit,Accessory,29.00,410,80
AC-010,Rack Shelf 2U,Accessory,59.00,220,50
SW-001,Analytics Add-on (per seat),Software,12.00,999,0
SW-002,Compliance Add-on (per seat),Software,18.00,999,0
SUP-001,Premium Support (per month),Service,450.00,999,0
SUP-002,Onboarding Workshop,Service,1200.00,999,0`,
  "doc-brief": `Q3 Campaign Brief — "Ship Faster" launch.
Objective: Drive 15 percent growth in Pro seat conversions among mid-market SaaS teams by end of Q3 2026.
Audience: Engineering and platform leads at 50-500 person companies evaluating delivery automation.
Key message: Ship faster with automated review loops — FlowMind pairs AI agents with human approval gates so nothing ships unreviewed.
Channels: LinkedIn thought leadership (2 posts per week), developer newsletter (biweekly), webinar with a design partner in week 6, and retargeting for pricing-page visitors.
Offer: 20 percent off the first 3 months for annual Pro plans purchased before September 30. Promo code SHIPFASTER20.
Success metrics: 400 demo requests, 12 percent landing-page conversion, CAC under $600, and at least 30 pieces of UGC from beta customers.
Risks: Webinar speaker availability in August, and possible creative fatigue after week 4 — plan a mid-flight refresh in week 5.`,
};

export async function ensureWorkspaceSettings(ownerId: string): Promise<void> {
  await db
    .insert(workspaceSettingsTable)
    .values({ ownerId, onboardingCompleted: false })
    .onConflictDoNothing();
}

export async function seedWorkspaceDemoContent(ownerId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [agentCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(agentsTable)
      .where(eq(agentsTable.ownerId, ownerId));
    if ((agentCount?.count ?? 0) > 0) return false;

    const id = (key: string) => `${ownerId}:${key}`;
    await tx.insert(agentsTable).values([
      { id: id("agent-communication"), ownerId, name: "Communication Agent", type: "Customer operations", initials: "CO", color: "#ed806f", status: "Active", runs: 248, description: "Classifies inbound requests and drafts thoughtful replies.", tools: ["Search knowledge", "Draft response", "Create task"] },
      { id: id("agent-document"), ownerId, name: "Document Agent", type: "Knowledge & compliance", initials: "DO", color: "#8b7be8", status: "Active", runs: 186, description: "Extracts key details from contracts, briefs, and reports.", tools: ["Search documents", "Extract data", "Generate report"] },
      { id: id("agent-marketing"), ownerId, name: "Marketing Agent", type: "Growth", initials: "MA", color: "#69bda4", status: "Active", runs: 94, description: "Turns a campaign brief into ready-to-review content.", tools: ["Create campaign", "Generate copy", "Send notification"] },
      { id: id("agent-project"), ownerId, name: "Project Agent", type: "Delivery", initials: "PA", color: "#6491d5", status: "Paused", runs: 76, description: "Surfaces risks and keeps project work moving forward.", tools: ["Create task", "Update task", "Analyze project"] },
      { id: id("agent-analytics"), ownerId, name: "Analytics Agent", type: "Business intelligence", initials: "AN", color: "#d0a13b", status: "Active", runs: 61, description: "Answers questions about operational data in plain language.", tools: ["Analyze CSV", "Explain trend", "Generate report"] },
    ]);

    await tx.insert(workflowsTable).values([
      {
        id: id("workflow-complaints"), ownerId, name: "Customer Complaint Handler",
        trigger: "Webhook call", triggerType: "webhook", webhookToken: randomUUID(),
        status: "Active", runs: 184, success: "98.4%", lastRun: "2 min ago", color: "#ed806f",
        steps: ["Capture the incoming complaint", "ai: Classify urgency and sentiment", "ai: Draft a response with source context", "approval: Request human approval when risk is high"],
      },
      {
        id: id("workflow-contracts"), ownerId, name: "Contract Review & Routing",
        trigger: "New document uploaded", triggerType: "manual",
        status: "Active", runs: 68, success: "100%", lastRun: "18 min ago", color: "#8b7be8",
        steps: ["Read the uploaded contract", "ai: Extract renewal date and key terms", "Create a review summary"],
      },
      {
        id: id("workflow-digest"), ownerId, name: "Weekly Project Digest",
        trigger: "Every Monday at 09:00", triggerType: "schedule", schedule: "0 9 * * 1",
        nextRunAt: nextRun("0 9 * * 1", new Date()),
        status: "Active", runs: 42, success: "97.6%", lastRun: "Yesterday", color: "#6491d5",
        steps: ["Collect project updates", "ai: Summarize blockers into a short digest", "Prepare a review digest"],
      },
      {
        id: id("workflow-campaign"), ownerId, name: "Campaign Approval Loop",
        trigger: "Manual trigger", triggerType: "manual",
        status: "Draft", runs: 12, success: "91.7%", lastRun: "Sep 26", color: "#69bda4",
        steps: ["Review campaign brief", "ai: Draft campaign copy from the brief", "approval: Request human approval for the campaign"],
      },
    ]);

    await tx.insert(projectsTable).values([
      { id: id("project-cx"), ownerId, name: "Customer Experience", code: "CX", color: "#ed806f", progress: 72, tasks: "18 / 25", owner: "AM", due: "Oct 18", health: "On track" },
      { id: id("project-web"), ownerId, name: "Website Redesign", code: "WR", color: "#8b7be8", progress: 48, tasks: "12 / 26", owner: "JS", due: "Nov 02", health: "At risk" },
      { id: id("project-growth"), ownerId, name: "Q4 Growth Campaign", code: "Q4", color: "#69bda4", progress: 31, tasks: "8 / 24", owner: "TK", due: "Nov 28", health: "On track" },
    ]);

    await tx.insert(documentsTable).values([
      { id: id("doc-vendor"), ownerId, name: "vendor-renewal-2026.pdf", type: "PDF", size: "2.4 MB", date: "Sep 30, 2026", status: "Processed", color: "#ed806f", objectPath: null, contentType: null, extractedText: SEED_DOCUMENT_TEXT["doc-vendor"] },
      { id: id("doc-faq"), ownerId, name: "customer-support-faq.pdf", type: "PDF", size: "840 KB", date: "Sep 29, 2026", status: "Processed", color: "#8b7be8", objectPath: null, contentType: null, extractedText: SEED_DOCUMENT_TEXT["doc-faq"] },
      { id: id("doc-catalog"), ownerId, name: "product-catalog.csv", type: "CSV", size: "128 KB", date: "Sep 28, 2026", status: "Processed", color: "#69bda4", objectPath: null, contentType: null, extractedText: SEED_DOCUMENT_TEXT["doc-catalog"] },
      { id: id("doc-brief"), ownerId, name: "q3-campaign-brief.docx", type: "DOCX", size: "1.1 MB", date: "Sep 27, 2026", status: "Processed", color: "#6491d5", objectPath: null, contentType: null, extractedText: SEED_DOCUMENT_TEXT["doc-brief"] },
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

    return true;
  });
}

// Older workspaces were seeded before document text and vector chunks existed.
// Runs once per owner per process; every step is idempotent.
export async function backfillWorkspaceContent(ownerId: string): Promise<void> {
  for (const [key, text] of Object.entries(SEED_DOCUMENT_TEXT)) {
    await db.update(documentsTable)
      .set({ extractedText: text, status: "Processed" })
      .where(and(eq(documentsTable.id, `${ownerId}:${key}`), isNull(documentsTable.extractedText)));
  }
  if (!process.env.GEMINI_API_KEY) return;
  const docs = await db
    .select({ id: documentsTable.id, text: documentsTable.extractedText })
    .from(documentsTable)
    .where(eq(documentsTable.ownerId, ownerId));
  for (const doc of docs) {
    if (!doc.text) continue;
    const [counts] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(documentChunksTable)
      .where(and(eq(documentChunksTable.ownerId, ownerId), eq(documentChunksTable.documentId, doc.id)));
    if ((counts?.count ?? 0) > 0) continue;
    try {
      await indexDocument(ownerId, doc.id, doc.text);
    } catch (error) {
      disableIndexing(error);
      return;
    }
  }
}
