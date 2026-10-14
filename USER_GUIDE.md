# FlowMind user guide

FlowMind is a workspace operations dashboard for AI-assisted agents, workflows, project analysis, and document knowledge. Data is scoped to the signed-in workspace user.

## Overview

The Overview page summarizes workspace activity and delivery status. Use **Ask command center** to ask a question about the workspace’s agents, workflows, projects, and approvals. The command center can look up projects, workflows, agents, pending approvals, recent activity, and search your documents; the answer lists the sources it used as chips (document chips link to the Documents page). Responses are generated from the information FlowMind has stored; check important conclusions against the source records.

The page also highlights recent activity and items that need review. If the workspace is new, some charts and lists remain empty until you create or run items.

## Notifications

The bell in the header shows an unread count and lists in-app notifications — approval requests, approval decisions, and the results of scheduled or webhook-triggered runs. Click a notification to jump to the relevant page (it is marked read); use **Mark all read** to clear the badge. FlowMind does not send email; everything stays in the app and is checked for updates every 30 seconds while a page is open.

## AI agents

Open **AI agents** to review the workspace’s available agents and their run totals. Create an agent from the page’s create action, then open an agent to run it. Answers stream in live as Gemini generates them, and agents can use extracted text from your processed documents as private context (controlled by the **Show source context** setting). Each agent keeps a run history (last 50 runs) with status, latency, token counts, and the full answer — expand a run to reread it.

## Workflows

Open **Workflows** to see saved automation flows, their status, and run totals. Create a workflow, edit its configuration, or open it to start a manual run. Every run executes in the background; the workflow page shows live progress and a run history with per-step status and output.

**How a workflow starts** (choose when creating or editing):

- **Manual** — you press **Run test** on the workflow page.
- **Schedule** — a five-field cron expression (minute, hour, day-of-month, month, day-of-week). For example `0 9 * * 1` runs weekdays at 9:00. The page shows the next run time; only **Active** workflows fire.
- **Webhook** — FlowMind generates a private URL shown on the workflow page. Any external tool that can send an HTTP POST (with a JSON body up to 4 KB) starts a run. Keep the URL secret — the token in it is the credential.

**Steps:** one per line. Prefix a step with `ai:` to have Gemini produce the step’s output, or `approval:` to pause the run until a human decides. Steps without a prefix are recorded as regular actions.

**Approvals pause runs:** when a run reaches an `approval:` step, the workflow’s run shows *Waiting* and an approval appears on the **Approvals** page (plus a bell notification). **Approve** resumes the run from that step; **Reject** stops the run and marks it failed with the reason.

The app does not connect to an external automation provider by default. Configure and test workflows against the actions available in the app before relying on them operationally.
## Projects

Open **Projects** to review project progress, due dates, health, and task counts. Choose **Analyze** on a project to ask Gemini for a status summary, top risks, and practical next steps. Treat that output as an AI-generated analysis, not as a change to the project record.

## Documents

Open **Documents** to add reference material for the workspace. Upload PDF, plain text, Markdown, CSV, JSON, or DOCX files up to 25 MB. FlowMind extracts readable text and saves it with the document record. You can download or delete a saved document from the list.

Use the search box at the top of the page to search across document **contents**. Search is semantic — it finds relevant passages even when the exact wording differs — and shows each match with its document, a similarity score, and the matched excerpt. If semantic search is unavailable (for example, the Gemini key is missing), it falls back to keyword matching.

Uploads are private to the workspace owner. Document bytes are stored by the configured storage adapter (local disk under `data/` in development, an S3-compatible bucket such as Neon Object Storage in production); the database stores document metadata, extracted text, and the embedding chunks used for search.

## Approvals

Open **Approvals** to see everything waiting on a human decision in one place. Pending items show the requesting agent, the context, and the proposed draft; **Approve as drafted** accepts it as-is, while **Review & edit** lets you change the text before approving. Approving a workflow-linked approval resumes that workflow run; rejecting stops it. Recent decisions are listed below the queue. An approval decision is recorded in the activity log and the bell notifications. Review the draft and supporting context before approving any action.

## Analytics

Analytics summarizes workflow and agent run totals and workflow status, plus an **AI usage** section for the selected period (7/14/30/90 days): total Gemini calls, input and output tokens, calls per day, and a per-feature breakdown (agent runs, command center, project analysis, workflow AI steps, embeddings). It is based on the saved workspace records; empty charts mean there is not yet enough run data. When the daily AI request limit is reached, AI features return a friendly "limit reached" message instead of running, and work again once the rolling 24-hour window frees up.

## Activity log

The Activity log lists recorded workspace events such as agent/workflow runs, project analysis, document processing, and approval decisions. Use it to see what FlowMind has recorded and when.

## Workspace settings

Open **Workspace settings** to update the workspace name and timezone and adjust the available review/source-context/digest preferences. These settings affect how the workspace presents dates and how the app handles review preferences.

## Account and data

Use **Sign out** in the lower-left account area to end the current session. In the local developer setup, sign-in is a single local account with no password and is not a production authentication method.

The app stores structured data in PostgreSQL and file uploads in the configured storage (local disk or an S3-compatible bucket). Back up both the database and the configured storage location. Deleting a document removes its stored file and metadata; deleting the Docker database volume removes all local database records.

For installation, local run commands, or deployment configuration, see [README.md](./README.md).
