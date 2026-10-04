import express from "express";
import path from "path";
import fs from "fs";
import { WebSocketServer } from "ws";
import cors from "cors";
import dotenv from "dotenv";
import { apiRouter } from "./server/routes";
import { metricsEngine } from "./server/metrics";
import { syncManager } from "./server/sync";
import { dbEngine } from "./server/db";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";

app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin", "X-Idempotency-Key"]
}));
app.options("*", cors());

app.use(express.json({
  limit: "50mb",
  verify: (req: any, res, buf) => {
    if (req.originalUrl && req.originalUrl.includes("/webhook")) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (!req.path.includes("/db/pulse") && !req.path.includes("/metrics")) {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: duration
      }));
    }
  });
  next();
});

app.post(["/github/push", "/api/github/push"], async (req, res) => {
  try {
    const token = req.body.token || process.env.GITHUB_TOKEN;
    const repo = req.body.repo || process.env.GITHUB_REPOSITORY || "deodatusmaliti2-tech/SiaraMaina-Clan-Informatics-01";
    if (!token) {
      return res.status(400).json({ success: false, error: "GitHub token not provided and GITHUB_TOKEN env var not set." });
    }
    const records = req.body.records || dbEngine.getCollection("records") || [];
    const deletedIds = dbEngine.getDeletedIds();
    const cleanRecords = records.filter((r: any) => r && r.id && !deletedIds.includes(String(r.id)));

    const payload = {
      project: "SiaraMaina Clan Informatics",
      exportedAt: new Date().toISOString(),
      count: cleanRecords.length,
      records: cleanRecords
    };

    const url = `https://api.github.com/repos/${repo}/contents/siara-maina-clan-data.json`;
    let commitData: any = null;
    let success = false;
    const maxRetries = 5;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const getRes = await fetch(url, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "SiaraMaina-Clan-Informatics"
          }
        });

        let sha: string | undefined = undefined;
        if (getRes.ok) {
          const fileData = await getRes.json() as any;
          sha = fileData.sha;
        }

        const contentStr = Buffer.from(JSON.stringify(payload, null, 2)).toString("base64");
        const putRes = await fetch(url, {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "SiaraMaina-Clan-Informatics"
          },
          body: JSON.stringify({
            message: `Sync clan dataset (${cleanRecords.length} records) from Google AI Studio / Cloud Engine`,
            content: contentStr,
            branch: process.env.GITHUB_BRANCH || "main",
            sha: sha
          })
        });

        if (putRes.ok) {
          commitData = await putRes.json();
          success = true;
          break;
        }

        const errTxt = await putRes.text();
        if (putRes.status === 409 && attempt < maxRetries) {
          console.warn(`[GitHub Push] 409 Conflict on attempt ${attempt}. Retrying with fresh SHA...`);
          await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
          continue;
        }
        throw new Error(`GitHub API error: ${putRes.status} - ${errTxt}`);
      } catch (retryErr: any) {
        if (attempt === maxRetries) {
          throw retryErr;
        }
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }

    if (!success) {
      throw new Error("GitHub push failed after max retries due to conflict resolution failure.");
    }

    res.json({ success: true, count: cleanRecords.length, commit: commitData });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use("/api", apiRouter);

app.get("/api/health", (req, res) => {
  const uptimeSeconds = process.uptime();
  const records = dbEngine.getCollection("records") || [];
  const users = dbEngine.getCollection("users") || [];
  const payments = dbEngine.getCollection("payments") || [];

  res.json({
    status: "ok",
    version: "2.1.0",
    engine: "Hardened Durable Entity-Separated JSON Engine",
    uptime: Math.floor(uptimeSeconds),
    clientsConnected: syncManager.getActiveClientCount(),
    database: {
      status: "connected",
      recordsCount: records.length,
      usersCount: users.length,
      paymentsCount: payments.length,
      version: dbEngine.getVersion(),
      lastModified: dbEngine.getLastModified(),
      storageMode: "Atomic File Replacement + fsync + SHA-256 Checksums",
    },
    timestamp: new Date().toISOString(),
  });
});

function resolveSpaEntry(): string {
  const possiblePaths = [
    path.join(process.cwd(), "index.html"),
    path.join(process.cwd(), "dist", "index.html"),
    path.join(process.cwd(), "SiaraMainaInformatics.html"),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(process.cwd(), "index.html");
}

app.get(["/", "/index.html", "/SiaraMainaInformatics.html"], (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(resolveSpaEntry());
});

app.use(express.static(process.cwd()));
const distPath = path.join(process.cwd(), "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "API route not found" });
  }
  res.sendFile(resolveSpaEntry());
});

const server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`SiaraMaina Hardened Backend Engine running on http://0.0.0.0:${PORT} [${isProd ? "PROD" : "DEV"}]`);
});

const wss = new WebSocketServer({ server, path: "/api/sync/ws" });
wss.on("connection", (ws, req) => {
  syncManager.registerWebSocket(ws, req);
});

const shutdown = (signal: string) => {
  console.log(`[Server] Received ${signal}. Creating emergency backup snapshot...`);
  dbEngine.createBackupSnapshot();
  server.close(() => {
    console.log("[Server] Closed gracefully.");
    process.exit(0);
  });
};

// Resilient handling for transient gRPC / HTTP2 stream resets (Code 14 UNAVAILABLE / ECONNRESET)
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message || String(reason || "");
  const code = reason?.code;
  if (code === 14 || code === "ECONNRESET" || msg.includes("ECONNRESET") || msg.includes("UNAVAILABLE")) {
    console.warn(`[Firestore Stream] Handled transient network stream reset: ${msg} (resuming cleanly)`);
    return;
  }
  console.error("[Server] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err: any) => {
  const msg = err?.message || String(err || "");
  const code = err?.code;
  if (code === 14 || code === "ECONNRESET" || msg.includes("ECONNRESET") || msg.includes("UNAVAILABLE")) {
    console.warn(`[Firestore Stream] Handled uncaught transient socket reset: ${msg} (resuming cleanly)`);
    return;
  }
  console.error("[Server] Uncaught exception:", err);
});

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

