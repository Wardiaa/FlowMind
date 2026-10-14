import { randomUUID } from "crypto";
import { db, notificationsTable } from "@workspace/db";

export type NotificationKind = "approval_pending" | "approval_decision" | "run_completed" | "run_failed";

export async function createNotification(
  ownerId: string,
  input: { kind: NotificationKind; title: string; body: string; href?: string | null },
): Promise<void> {
  try {
    await db.insert(notificationsTable).values({
      id: randomUUID(),
      ownerId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      href: input.href ?? null,
    });
  } catch (error) {
    console.error("Failed to create notification", error);
  }
}
