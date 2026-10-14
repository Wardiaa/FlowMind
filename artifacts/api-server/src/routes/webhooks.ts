import { eq } from "drizzle-orm";
import { db, workflowsTable } from "@workspace/db";
import { Router, type IRouter } from "express";
import { startExecution } from "../lib/workflowEngine";

const router: IRouter = Router();

// Public trigger endpoint: the random per-workflow token is the credential.
router.post("/webhooks/workflows/:token", (req, res, next) => {
  void (async () => {
    try {
      const token = typeof req.params.token === "string" ? req.params.token : "";
      if (!token) {
        res.status(404).json({ error: "Unknown webhook." });
        return;
      }
      const [workflow] = await db.select().from(workflowsTable).where(eq(workflowsTable.webhookToken, token));
      if (!workflow || workflow.triggerType !== "webhook" || workflow.status !== "Active") {
        res.status(404).json({ error: "Unknown webhook." });
        return;
      }
      const executionId = await startExecution(workflow, workflow.ownerId, {
        triggerSource: "webhook",
        webhookInput: sanitizeInput(req.body),
      });
      res.status(202).json({ executionId });
    } catch (error) {
      next(error);
    }
  })();
});

function sanitizeInput(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(body);
  } catch {
    return null;
  }
  if (json.length > 4_000) json = json.slice(0, 4_000);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default router;
