# FlowMind user guide

FlowMind is a workspace operations dashboard for AI-assisted agents, workflows, project analysis, and document knowledge. Data is scoped to the signed-in workspace user.

## Overview

The Overview page summarizes workspace activity and delivery status. Use **Ask command center** to ask a question about the workspace’s agents, workflows, projects, and approvals. The response is generated from the information FlowMind has stored; check important conclusions against the source records.

The page also highlights recent activity and items that need review. If the workspace is new, some charts and lists remain empty until you create or run items.

## AI agents

Open **AI agents** to review the workspace’s available agents and their run totals. Create an agent from the page’s create action, then open an agent to run it. Runs update the agent’s activity and run count; check the returned result before acting on it.

## Workflows

Open **Workflows** to see saved automation flows, their status, and run totals. Create a workflow, edit its configuration, or open it to start a manual run. Use the workflow’s status controls to pause or resume it. Review the latest run result and activity after a run.

The app does not connect to an external automation provider by default. Configure and test workflows against the actions available in the app before relying on them operationally.
## Projects

Open **Projects** to review project progress, due dates, health, and task counts. Choose **Analyze** on a project to ask Gemini for a status summary, top risks, and practical next steps. Treat that output as an AI-generated analysis, not as a change to the project record.

## Documents

Open **Documents** to add reference material for the workspace. Upload PDF, plain text, Markdown, CSV, JSON, or DOCX files up to 25 MB. FlowMind extracts readable text and saves it with the document record. You can download or delete a saved document from the list.

Uploads are private to the workspace owner. Document bytes are stored by the configured storage adapter (local disk under `data/` in development, an S3-compatible bucket such as Neon Object Storage in production); the database stores document metadata and extracted text.

## Approvals

Review approval items surfaced in the workspace and choose the available decision. An approval decision is recorded in the activity log. Review the draft and supporting context before approving any action.

## Analytics

Analytics summarizes workflow and agent run totals and workflow status. It is based on the saved workspace records; empty charts mean there is not yet enough run data.

## Activity log

The Activity log lists recorded workspace events such as agent/workflow runs, project analysis, document processing, and approval decisions. Use it to see what FlowMind has recorded and when.

## Workspace settings

Open **Workspace settings** to update the workspace name and timezone and adjust the available review/source-context/digest preferences. These settings affect how the workspace presents dates and how the app handles review preferences.

## Account and data

Use **Sign out** in the lower-left account area to end the current session. In the local developer setup, sign-in is a single local account with no password and is not a production authentication method.

The app stores structured data in PostgreSQL and file uploads in the configured storage (local disk or an S3-compatible bucket). Back up both the database and the configured storage location. Deleting a document removes its stored file and metadata; deleting the Docker database volume removes all local database records.

For installation, local run commands, or deployment configuration, see [README.md](./README.md).
