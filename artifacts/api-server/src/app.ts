import express, { type ErrorRequestHandler, type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const allowedOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || process.env.PUBLIC_APP_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed."));
  },
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  const webBuildPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../flowmind/dist/public",
  );
  app.use(express.static(webBuildPath, {
    index: false,
    fallthrough: true,
    maxAge: "1h",
  }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res, next) => {
    res.sendFile(path.join(webBuildPath, "index.html"), (error) => {
      if (error) next(error);
    });
  });
}

const apiErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const reportedStatus = typeof error === "object" && error !== null && "status" in error
    ? error.status
    : undefined;
  const status = error instanceof Error && error.name === "ZodError"
    ? 400
    : typeof reportedStatus === "number" && reportedStatus >= 400 && reportedStatus < 500
      ? reportedStatus
      : 500;
  if (status >= 500) req.log.error({ err: error }, "API request failed");
  else req.log.info({ status, err: error }, "API request rejected");
  const exposeMessage = error instanceof Error && (error as { expose?: boolean }).expose === true;
  res.status(status).json({
    error: exposeMessage
      ? error.message
      : status === 400
        ? "The request contains invalid data."
        : "The request could not be completed.",
  });
};

app.use(apiErrorHandler);

export default app;
