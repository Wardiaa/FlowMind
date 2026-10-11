import { Router, type IRouter } from "express";
import healthRouter from "./health";
import flowmindRouter from "./flowmind";
import authRouter from "./auth";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(storageRouter);
router.use(flowmindRouter);

export default router;
