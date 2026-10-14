import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, executionsTable, workflowsTable } from "@workspace/db";
import { nextRun } from "./cron";
import { createNotification } from "./notify";
import { startExecution } from "./workflowEngine";

const TICK_MS = 30_000;

// Runs inside the single API process. A horizontally scaled deployment would need
// advisory locks (or an external queue) so two instances do not double-fire runs.
export function startScheduler(): void {
  void initializeSchedules();
  setInterval(() => {
    void tick();
  }, TICK_MS).unref();
}

// Workflows switched to a schedule before any boot sweep (or with a cleared
// nextRunAt) get an initial next-run time.
async function initializeSchedules(): Promise<void> {
  try {
    const rows = await db.select().from(workflowsTable).where(
      and(eq(workflowsTable.triggerType, "schedule"), eq(workflowsTable.status, "Active"), isNull(workflowsTable.nextRunAt)),
    );
    for (const workflow of rows) {
      try {
        await db.update(workflowsTable)
          .set({ nextRunAt: nextRun(workflow.schedule ?? "") })
          .where(eq(workflowsTable.id, workflow.id));
      } catch (error) {
        console.error(`Invalid schedule for workflow ${workflow.id}`, error);
      }
    }
  } catch (error) {
    console.error("Scheduler initialization failed", error);
  }
}

async function tick(): Promise<void> {
  try {
    const due = await db.select().from(workflowsTable).where(
      and(
        eq(workflowsTable.triggerType, "schedule"),
        eq(workflowsTable.status, "Active"),
        lte(workflowsTable.nextRunAt, new Date()),
      ),
    );
    for (const workflow of due) {
      let next: Date;
      try {
        // Advance from the scheduled time, not from now, so a late poll cannot drift.
        const base = workflow.nextRunAt && workflow.nextRunAt.getTime() > Date.now() ? workflow.nextRunAt : new Date();
        next = nextRun(workflow.schedule ?? "", base);
      } catch (error) {
        console.error(`Invalid schedule for workflow ${workflow.id}; disabling its schedule.`, error);
        await db.update(workflowsTable).set({ nextRunAt: null }).where(eq(workflowsTable.id, workflow.id));
        await createNotification(workflow.ownerId, {
          kind: "run_failed",
          title: `${workflow.name} schedule is invalid`,
          body: `The cron expression "${workflow.schedule ?? ""}" could not be parsed. Fix it in the workflow editor.`,
          href: `/workflows/${workflow.id}`,
        });
        continue;
      }
      await db.update(workflowsTable).set({ nextRunAt: next }).where(eq(workflowsTable.id, workflow.id));

      const [busy] = await db.select({ count: sql<number>`count(*)::int` }).from(executionsTable).where(
        and(eq(executionsTable.workflowId, workflow.id), inArray(executionsTable.status, ["Running", "Waiting"])),
      );
      if ((busy?.count ?? 0) > 0) continue;
      await startExecution(workflow, workflow.ownerId, { triggerSource: "schedule" });
    }
  } catch (error) {
    console.error("Scheduler tick failed", error);
  }
}
