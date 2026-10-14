import { Router, type IRouter } from "express";
import healthRouter from "./health";
import flowmindRouter from "./flowmind";
import authRouter from "./auth";
import storageRouter from "./storage";
import webhooksRouter from "./webhooks";
import notificationsRouter from "./notifications";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(storageRouter);
router.use(webhooksRouter);
router.use(notificationsRouter);
router.use(flowmindRouter);

export default router;
