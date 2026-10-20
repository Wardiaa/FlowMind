import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import {
  ListNotificationsResponse,
  MarkAllNotificationsReadResponse,
  MarkNotificationReadParams,
  MarkNotificationReadResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request } from "express";
import { ensureWorkspaceSettings } from "../lib/flowmindSeed";

const router: IRouter = Router();

function owner(req: Request): string {
  if (!req.isAuthenticated()) throw new Error("Sign in is required.");
  return req.user.id;
}

router.use((req, res, next) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Sign in to access this workspace." });
    return;
  }
  next();
});

router.use(async (req, res, next) => {
  try {
    await ensureWorkspaceSettings(owner(req));
    next();
  } catch (error) {
    next(error);
  }
});

function notificationDto(row: typeof notificationsTable.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

async function notificationPayload(userId: string) {
  const [items, unread] = await Promise.all([
    db.select().from(notificationsTable).where(eq(notificationsTable.ownerId, userId))
      .orderBy(desc(notificationsTable.createdAt)).limit(50),
    db.select({ count: sql<number>`count(*)::int` }).from(notificationsTable)
      .where(and(eq(notificationsTable.ownerId, userId), isNull(notificationsTable.readAt))),
  ]);
  return { items: items.map(notificationDto), unreadCount: unread[0]?.count ?? 0 };
}

router.get("/notifications", async (req, res, next) => {
  try {
    res.json(ListNotificationsResponse.parse(await notificationPayload(owner(req))));
  } catch (error) { next(error); }
});

router.post("/notifications/read-all", async (req, res, next) => {
  try {
    const userId = owner(req);
    await db.update(notificationsTable).set({ readAt: new Date() })
      .where(and(eq(notificationsTable.ownerId, userId), isNull(notificationsTable.readAt)));
    res.json(MarkAllNotificationsReadResponse.parse(await notificationPayload(userId)));
  } catch (error) { next(error); }
});

router.post("/notifications/:id/read", async (req, res, next) => {
  try {
    const userId = owner(req);
    const { id } = MarkNotificationReadParams.parse(req.params);
    await db.update(notificationsTable).set({ readAt: new Date() })
      .where(and(eq(notificationsTable.id, id), eq(notificationsTable.ownerId, userId), isNull(notificationsTable.readAt)));
    res.json(MarkNotificationReadResponse.parse(await notificationPayload(userId)));
  } catch (error) { next(error); }
});

export default router;
