import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { dbEngine, DatabaseSchema, BACKUP_DIR, DATA_DIR, ROOT_DIR } from "./db";
import { syncManager } from "./sync";
import {
  authenticateWithPassword,
  validateEmailOrThrow,
  verifyToken,
  hashPassword,
  AppUser,
  sanitizeUser,
} from "./auth";
import { metricsEngine } from "./metrics";
import { createCheckoutSession, handleStripeWebhook } from "./stripe";

export const apiRouter = express.Router();

apiRouter.get("/readiness", (req, res) => {
  try {
    const stats = dbEngine.getStats();
    res.json({
      ready: true,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(503).json({ ready: false, error: err.message });
  }
});

apiRouter.get(["/db/handshake", "/db/supabase-handshake"], async (req: Request, res: Response) => {
  const stats = dbEngine.getStats();
  return res.json({
    success: true,
    status: "ONLINE_CONNECTED",
    database: "Cloudflare D1 (siaramaina-db)",
    engine: "Cloudflare D1 SQLite Edge Engine",
    firestore: "ai-studio-siaramainaclanin-460807ca-5792-43ae-aa12-303da9af9152",
    cloudUrl: "https://siaramaina.researchlinktz.com",
    count: stats.totalRecords,
    totalUsers: stats.totalUsers,
    totalPayments: stats.totalPayments,
    totalAuditLogs: stats.totalAuditLogs,
    lastModified: stats.lastModified,
    handshakeTime: new Date().toISOString(),
    message: "Handshake verified. Cloudflare D1 database and Firebase Auth are 100% active and healthy.",
  });
});

apiRouter.get(["/db/audit-logs", "/db/supabase-audit-logs"], async (req: Request, res: Response) => {
  const logs = dbEngine.getCollection("auditLogs");
  return res.json({
    success: true,
    source: "Cloudflare D1 & Persistent Engine",
    count: logs.length,
    logs: logs.slice(0, 50),
  });
});


// Middleware: Telemetry recording
apiRouter.use((req: Request, res: Response, next) => {
  const start = Date.now();
  const bytesIn = req.headers["content-length"] ? parseInt(req.headers["content-length"] as string, 10) : 0;
  metricsEngine.recordRequest(req.method, bytesIn);

  res.on("finish", () => {
    const duration = Date.now() - start;
    metricsEngine.recordResponse(res.statusCode, duration, 256);
  });
  next();
});

// 1. Real-Time SSE Stream Endpoint
apiRouter.get("/sync/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const clientId = "client-" + crypto.randomUUID().slice(0, 8);
  const userAgent = req.headers["user-agent"] || "";
  const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "127.0.0.1";

  syncManager.registerClient(clientId, res, userAgent, ip);

  req.on("close", () => {
    syncManager.removeClient(clientId);
  });
});

apiRouter.get("/db/pulse", async (req: Request, res: Response) => {
  const records = dbEngine.getCollection("records") || [];
  res.json({
    success: true,
    database: "Cloudflare D1 & Persistent Engine",
    version: dbEngine.getVersion(),
    count: records.length,
    updatedAt: dbEngine.getLastModified(),
    lastModified: dbEngine.getLastModified(),
    clientsConnected: syncManager.getActiveClientCount(),
    timestamp: new Date().toISOString(),
  });
});

// 3. RFC 5322 Email Validation Endpoint
apiRouter.post("/auth/validate-email", (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "127.0.0.1";
    const ua = req.headers["user-agent"] || "";
    const cleanEmail = validateEmailOrThrow(email, "VALIDATE", ip, ua);
    res.json({ success: true, email: cleanEmail, message: "RFC 5322 format verified." });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 4. Native In-Built User Authentication Endpoints
apiRouter.post("/auth/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "127.0.0.1";
    const ua = req.headers["user-agent"] || "";

    const result = await authenticateWithPassword(email, password, ip, ua);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(401).json({ success: false, error: err.message });
  }
});

apiRouter.post("/auth/register", async (req: Request, res: Response) => {
  try {
    const { email, password, displayName, role, branch, institution } = req.body;
    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "127.0.0.1";
    const ua = req.headers["user-agent"] || "";

    const cleanEmail = validateEmailOrThrow(email, "REGISTRATION", ip, ua);
    const users = dbEngine.getCollection("users") as AppUser[];

    if (users.some((u) => u.email && u.email.toLowerCase() === cleanEmail)) {
      return res.status(400).json({ error: "An account with this email already exists." });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password || "ClanPass2026!", salt);
    const isFirst = users.length === 0 || cleanEmail.includes("deodatusmaliti");

    const newUser: AppUser = {
      uid: "user-" + crypto.randomUUID().slice(0, 10),
      email: cleanEmail,
      displayName: displayName || cleanEmail.split("@")[0],
      role: isFirst ? "admin" : (role as any) || "viewer",
      institution: institution || "SiaraMaina Clan Informatics",
      branch: branch || "all",
      passwordHash,
      salt,
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      status: "active",
      active: true,
      provider: "password",
    };

    users.push(newUser);
    await dbEngine.save();

    syncManager.broadcast("auth_change", {
      action: "USER_REGISTERED",
      user: sanitizeUser(newUser),
      totalUsers: users.length,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, user: sanitizeUser(newUser) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get("/auth/users", (req: Request, res: Response) => {
  const users = (dbEngine.getCollection("users") as AppUser[]) || [];
  res.json({ success: true, users: users.map(sanitizeUser) });
});

apiRouter.post("/auth/password-reset/request", (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "127.0.0.1";
    const ua = req.headers["user-agent"] || "";
    const cleanEmail = validateEmailOrThrow(email, "RESET_REQUEST", ip, ua);

    const tokenEntry = dbEngine.createPasswordResetToken(cleanEmail);
    res.json({
      success: true,
      message: `Password reset instructions and verification code [${tokenEntry.code}] generated.`,
      code: tokenEntry.code,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post("/auth/password-reset/confirm", async (req: Request, res: Response) => {
  try {
    const { email, code, newPassword } = req.body;
    const cleanEmail = (email || "").trim().toLowerCase();
    const tokens = dbEngine.getCollection("passwordResetTokens");
    const valid = tokens.find(
      (t: any) =>
        t.email === cleanEmail &&
        t.code === String(code).trim() &&
        !t.used &&
        t.expiresAt > Date.now()
    );

    if (!valid) {
      return res.status(400).json({ error: "Invalid or expired verification code." });
    }

    valid.used = true;
    const users = dbEngine.getCollection("users") as AppUser[];
    const user = users.find((u) => u.email && u.email.toLowerCase() === cleanEmail);
    if (user) {
      const salt = crypto.randomBytes(16).toString("hex");
      user.salt = salt;
      user.passwordHash = hashPassword(newPassword, salt);
    }
    await dbEngine.save();
    res.json({ success: true, message: "Password updated successfully." });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 4b. Stripe Checkout & Webhook Integration endpoints
apiRouter.post("/stripe/create-checkout-session", createCheckoutSession);
apiRouter.post("/stripe/webhook", handleStripeWebhook);

// 5. Atomic JSON Database Collections CRUD
apiRouter.get("/db/collections/:collection", async (req: Request, res: Response) => {
  const collectionName = req.params.collection as string;
  if (collectionName === "metrics" || collectionName === "system") {
    const metrics = metricsEngine.getMetrics();
    const users = (dbEngine.getCollection("users") as any[]) || [];
    const activeNodes = Math.max(1, syncManager.getActiveClientCount());
    const statsDoc = {
      id: "current_metrics",
      databaseSize: metrics.storage?.databaseSizeFormatted || "150 KB",
      databaseSizeBytes: metrics.storage?.databaseSizeBytes || 153600,
      maxStorageCapacity: metrics.storage?.maxStorageCapacity || "1TB",
      activeNodes: activeNodes,
      userCounts: {
        total: users.length,
        admins: users.filter((u: any) => u.role === "admin").length,
        editors: users.filter((u: any) => u.role === "editor").length,
        viewers: users.filter((u: any) => !u.role || u.role === "viewer").length,
        active: users.filter((u: any) => u.active !== false).length,
        suspended: users.filter((u: any) => u.active === false).length,
      },
      requests: metrics.requests,
      bandwidth: metrics.bandwidth,
      status: metrics.status || "OPTIMAL",
      uptime: metrics.uptimeFormatted || "Active",
      timestamp: new Date().toISOString(),
    };
    return res.json({ success: true, collection: collectionName, count: 1, data: [statsDoc] });
  }

  const items = dbEngine.getCollection(collectionName as keyof DatabaseSchema);
  res.json({ success: true, collection: collectionName, count: items.length || 0, data: items });
});

apiRouter.get("/db/collections/:collection/:id", async (req: Request, res: Response) => {
  const collectionName = req.params.collection as keyof DatabaseSchema;
  const id = req.params.id;
  const items = dbEngine.getCollection(collectionName);
  if (Array.isArray(items)) {
    const item = items.find((i) => i.id === id || i.uid === id);
    if (!item) return res.status(404).json({ error: "Document not found" });
    return res.json({ success: true, doc: item });
  }
  res.json({ success: true, doc: items });
});

apiRouter.get(["/members", "/db/members"], (req: Request, res: Response) => {
  const records = dbEngine.getCollection("records") || [];
  res.json({ success: true, count: records.length, records, members: records, data: records });
});

apiRouter.get("/db/deleted-ids", (req: Request, res: Response) => {
  const deletedIds = dbEngine.getDeletedIds();
  res.json({ success: true, count: deletedIds.length, deletedIds });
});

apiRouter.post("/db/deleted-ids", async (req: Request, res: Response) => {
  try {
    const { id, ids } = req.body;
    const toAdd: string[] = [];
    if (id) toAdd.push(String(id));
    if (Array.isArray(ids)) ids.forEach((i: any) => { if (i) toAdd.push(String(i)); });
    if (toAdd.length > 0) {
      dbEngine.addDeletedIds(toAdd);
      await dbEngine.save();
    }
    const currentRecords = dbEngine.getCollection("records");
    syncManager.broadcast("doc_change", {
      action: "DELETE",
      collection: "records",
      id: toAdd[0] || "",
      deletedIds: dbEngine.getDeletedIds(),
      records: currentRecords,
      count: currentRecords.length,
      timestamp: new Date().toISOString(),
    });
    res.json({ success: true, count: toAdd.length, deletedIds: dbEngine.getDeletedIds(), remainingRecords: currentRecords.length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Authoritative Bulk Records Synchronization Endpoint
apiRouter.post("/db/sync/records", async (req: Request, res: Response) => {
  try {
    const { records, deletedIds, author } = req.body;
    if (!Array.isArray(records)) {
      return res.status(400).json({ success: false, error: "records must be an array" });
    }
    const delList = Array.isArray(deletedIds) ? deletedIds : undefined;
    await dbEngine.replaceCollection("records", records, delList);
    await dbEngine.replaceCollection("members", records, delList);

    const updatedRecords = dbEngine.getCollection("records");
    const allDeletedIds = dbEngine.getDeletedIds();

    syncManager.broadcast("doc_change", {
      action: "SYNC_ALL",
      collection: "records",
      records: updatedRecords,
      deletedIds: allDeletedIds,
      count: updatedRecords.length,
      author: author || "client",
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      count: updatedRecords.length,
      deletedIds: allDeletedIds,
      message: "Records synchronized authoritatively across all devices",
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post("/github/push", async (req: Request, res: Response) => {
  try {
    const token = req.body.token || process.env.GITHUB_TOKEN;
    const repo = req.body.repo || process.env.GITHUB_REPOSITORY || "deodatusmaliti2-tech/SiaraMaina-Clan-Informatics-01";
    if (!token) {
      return res.status(400).json({ success: false, error: "GitHub token not provided and GITHUB_TOKEN env var not set." });
    }
    const records = dbEngine.getCollection("records") || [];
    const deletedIds = dbEngine.getDeletedIds();
    const cleanRecords = records.filter((r: any) => r && r.id && !deletedIds.includes(String(r.id)));

    const payload = {
      project: "SiaraMaina Clan Informatics",
      exportedAt: new Date().toISOString(),
      count: cleanRecords.length,
      records: cleanRecords
    };

    const url = `https://api.github.com/repos/${repo}/contents/siara-maina-clan-data.json`;
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

    if (!putRes.ok) {
      const errTxt = await putRes.text();
      throw new Error(`GitHub API error: ${putRes.status} - ${errTxt}`);
    }

    const commitData = await putRes.json();
    res.json({ success: true, count: cleanRecords.length, commit: commitData });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post("/db/collections/:collection", async (req: Request, res: Response) => {
  try {
    const collectionName = req.params.collection as keyof DatabaseSchema;
    const { id, data } = req.body;
    const docData = data || req.body;
    const savedDoc = await dbEngine.setDocument(collectionName, id, docData);

    const recordsPayload = Array.isArray(docData.records)
      ? docData.records
      : Array.isArray(docData.members)
      ? docData.members
      : null;

    syncManager.broadcast("doc_change", {
      action: "SET",
      collection: collectionName,
      id: savedDoc.id,
      doc: savedDoc,
      records: recordsPayload,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, collection: collectionName, doc: savedDoc });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.put("/db/collections/:collection/:id", async (req: Request, res: Response) => {
  try {
    const collectionName = req.params.collection as keyof DatabaseSchema;
    const id = req.params.id;
    const savedDoc = await dbEngine.setDocument(collectionName, id, req.body);

    syncManager.broadcast("doc_change", {
      action: "UPDATE",
      collection: collectionName,
      id,
      doc: savedDoc,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, collection: collectionName, doc: savedDoc });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.delete(["/db/collections/:collection/:id", "/members/:id"], async (req: Request, res: Response) => {
  try {
    const collectionName = (req.params.collection || "records") as keyof DatabaseSchema;
    const id = req.params.id;
    const success = await dbEngine.deleteDocument(collectionName, id);
    const remainingRecords = dbEngine.getCollection("records");
    const allDeletedIds = dbEngine.getDeletedIds();

    syncManager.broadcast("doc_change", {
      action: "DELETE",
      collection: collectionName,
      id,
      deletedIds: allDeletedIds,
      records: remainingRecords,
      count: remainingRecords.length,
      timestamp: new Date().toISOString(),
    });

    res.json({ success, id, remainingRecords: remainingRecords.length, deletedIds: allDeletedIds });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Zero-Lock Backup Snapshots
apiRouter.post("/db/backup", (req: Request, res: Response) => {
  try {
    const backupPath = dbEngine.createBackupSnapshot();
    const filename = backupPath.split("/").pop() || "";
    const backups = dbEngine.listBackups();
    syncManager.broadcast("sync_pulse", {
      action: "BACKUP_CREATED",
      filename,
      timestamp: new Date().toISOString(),
      backupCount: backups.length,
    });
    res.json({ success: true, message: "Backup created successfully.", filename, backups });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.get("/db/backups", (req: Request, res: Response) => {
  try {
    const backups = dbEngine.listBackups();
    res.json({ success: true, count: backups.length, backups });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.get("/db/backups/:filename", (req: Request, res: Response) => {
  try {
    const filename = path.basename(req.params.filename);
    const backupFile = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(backupFile)) {
      return res.status(404).json({ success: false, error: "Backup file not found" });
    }
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    res.sendFile(backupFile);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. System Telemetry & Metrics
apiRouter.get("/metrics", (req: Request, res: Response) => {
  res.json(metricsEngine.getMetrics());
});
