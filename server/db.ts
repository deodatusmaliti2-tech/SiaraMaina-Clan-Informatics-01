import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveAppRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "../.."),
    path.resolve(__dirname),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
  }
  return process.cwd();
}

export const ROOT_DIR = resolveAppRoot();
export const DATA_DIR = process.env.DATA_DIR || path.resolve(ROOT_DIR, "data");
export const BACKUP_DIR = path.resolve(DATA_DIR, "backups");
export const CLAN_DATA_FILE = path.resolve(ROOT_DIR, "siara-maina-clan-data.json");
export const USERS_DATA_FILE = path.resolve(ROOT_DIR, "siara-maina-clan-users.json");

export const RECORDS_FILE = path.resolve(DATA_DIR, "records.json");
export const USERS_FILE = path.resolve(DATA_DIR, "users.json");
export const PAYMENTS_FILE = path.resolve(DATA_DIR, "payments.json");
export const AUDIT_FILE = path.resolve(DATA_DIR, "audit_logs.json");

export interface DatabaseSchema {
  records: any[];
  users: any[];
  payments: any[];
  auditLogs: any[];
}

function calculateChecksum(data: string): string {
  return crypto.createHash("sha256").update(data, "utf-8").digest("hex");
}

export function atomicWriteJsonSync(filePath: string, dataObj: any): string {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const jsonContent = JSON.stringify(dataObj, null, 2);
  const checksum = calculateChecksum(jsonContent);
  const checksumPath = `${filePath}.checksum`;

  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, jsonContent, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, filePath);
  fs.writeFileSync(checksumPath, checksum, "utf-8");

  // Also mirror to main siara-maina-clan-data.json if records file
  if (filePath === RECORDS_FILE) {
    try {
      fs.writeFileSync(CLAN_DATA_FILE, jsonContent, "utf-8");
    } catch {}
  } else if (filePath === USERS_FILE) {
    try {
      fs.writeFileSync(USERS_DATA_FILE, jsonContent, "utf-8");
    } catch {}
  }

  return checksum;
}

export function atomicReadJsonSync(filePath: string, defaultVal: any): any {
  try {
    if (!fs.existsSync(filePath)) {
      if (filePath === RECORDS_FILE && fs.existsSync(CLAN_DATA_FILE)) {
        const raw = fs.readFileSync(CLAN_DATA_FILE, "utf-8");
        return JSON.parse(raw);
      }
      if (filePath === USERS_FILE && fs.existsSync(USERS_DATA_FILE)) {
        const raw = fs.readFileSync(USERS_DATA_FILE, "utf-8");
        return JSON.parse(raw);
      }
      return defaultVal;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[DatabaseEngine] Error reading ${filePath}:`, err);
    return defaultVal;
  }
}

class SelfSustainingJsonDatabaseEngine {
  private records: any[] = [];
  private users: any[] = [];
  private payments: any[] = [];
  private auditLogs: any[] = [];
  private version: number = Date.now();
  private lastModified: string = new Date().toISOString();
  private processedIdempotencyKeys: Set<string> = new Set();
  private isWriting: boolean = false;
  private writeQueue: (() => Promise<void>)[] = [];

  constructor() {
    this.ensureDirs();
    this.loadAll();
    this.createBackupSnapshot();
  }

  private ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  private loadAll() {
    const loadedRecords = atomicReadJsonSync(RECORDS_FILE, null);
    if (Array.isArray(loadedRecords)) {
      this.records = loadedRecords.filter((r: any) => r && r.id !== "master_ledger" && r.id !== "all" && (r.firstName || r.lastName));
    } else if (fs.existsSync(CLAN_DATA_FILE)) {
      try {
        const raw = fs.readFileSync(CLAN_DATA_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed.records || parsed.members || []);
        this.records = list.filter((r: any) => r && r.id !== "master_ledger" && r.id !== "all" && (r.firstName || r.lastName));
      } catch {}
    }

    const loadedUsers = atomicReadJsonSync(USERS_FILE, null);
    if (Array.isArray(loadedUsers)) {
      this.users = loadedUsers;
    } else if (fs.existsSync(USERS_DATA_FILE)) {
      try {
        const raw = fs.readFileSync(USERS_DATA_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        this.users = Array.isArray(parsed) ? parsed : (parsed.users || []);
      } catch {}
    }

    this.payments = atomicReadJsonSync(PAYMENTS_FILE, []);
    this.auditLogs = atomicReadJsonSync(AUDIT_FILE, []);

    // Ensure default admin user if no users exist
    if (this.users.length === 0) {
      this.users.push({
        uid: "user-admin-01",
        email: "deodatusmaliti2@gmail.com",
        displayName: "Deodatus Maliti",
        role: "admin",
        institution: "SiaraMaina Clan Informatics",
        branch: "all",
        createdAt: new Date().toISOString(),
        active: true,
      });
    }

    this.persistAll();
  }

  private persistAll() {
    atomicWriteJsonSync(RECORDS_FILE, this.records);
    atomicWriteJsonSync(USERS_FILE, this.users);
    atomicWriteJsonSync(PAYMENTS_FILE, this.payments);
    atomicWriteJsonSync(AUDIT_FILE, this.auditLogs);
  }

  public getVersion(): number {
    return this.version;
  }

  public getLastModified(): string {
    return this.lastModified;
  }

  public getCollection(name: string): any[] {
    if (name === "records" || name === "members") {
      return this.records.filter((r: any) => r && r.id !== "master_ledger" && r.id !== "all" && (r.firstName || r.lastName));
    }
    if (name === "users") return this.users;
    if (name === "payments") return this.payments;
    if (name === "auditLogs" || name === "audit_logs") return this.auditLogs;
    return [];
  }

  public async save(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.writeQueue.push(async () => {
        try {
          this.version = Date.now();
          this.lastModified = new Date().toISOString();
          this.persistAll();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      this.processQueue();
    });
  }

  public async pullLatestFromCloud(): Promise<void> {
    return Promise.resolve();
  }

  public async pullLatestFromSupabase(): Promise<void> {
    return this.pullLatestFromCloud();
  }

  private async processQueue() {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;
    const task = this.writeQueue.shift();
    if (task) {
      try {
        await task();
      } catch (err) {
        console.error("[JsonDatabaseEngine] Write task failed:", err);
      }
    }
    this.isWriting = false;
    if (this.writeQueue.length > 0) {
      this.processQueue();
    }
  }

  public checkIdempotency(key?: string): boolean {
    if (!key) return false;
    if (this.processedIdempotencyKeys.has(key)) return true;
    this.processedIdempotencyKeys.add(key);
    if (this.processedIdempotencyKeys.size > 1000) {
      const firstKey = this.processedIdempotencyKeys.values().next().value;
      if (firstKey) this.processedIdempotencyKeys.delete(firstKey);
    }
    return false;
  }

  public async replaceCollection(name: string, items: any[]): Promise<boolean> {
    const list = Array.isArray(items) ? [...items] : [];
    if (name === "records" || name === "members") {
      this.records = list
        .filter((r) => r && r.id !== "master_ledger" && r.id !== "all" && (r.firstName || r.lastName))
        .map((r) => ({
          ...r,
          v: (r.v || 0) + 1,
          updatedAt: new Date().toISOString(),
        }));
    } else if (name === "users") {
      this.users = list;
    } else if (name === "payments") {
      this.payments = list;
    }
    await this.save();
    return true;
  }

  public async setDocument(collectionName: string, id: string, docData: any, idempotencyKey?: string): Promise<any> {
    if (this.checkIdempotency(idempotencyKey)) {
      return docData;
    }

    const timestamp = new Date().toISOString();
    const docId = id || docData.id || docData.uid || "rec-" + crypto.randomUUID().slice(0, 10);

    // Intercept ledger wrapper docs and sync actual payload instead of polluting records
    if ((collectionName === "records" || collectionName === "members") && (docId === "master_ledger" || docId === "all")) {
      const payloadList = Array.isArray(docData.records)
        ? docData.records
        : Array.isArray(docData.members)
        ? docData.members
        : null;
      if (payloadList !== null) {
        await this.replaceCollection("records", payloadList);
      }
      return { id: docId, ...docData, updatedAt: timestamp };
    }

    let targetList: any[];
    if (collectionName === "records" || collectionName === "members") {
      targetList = this.records;
    } else if (collectionName === "users") {
      targetList = this.users;
    } else if (collectionName === "payments") {
      targetList = this.payments;
    } else {
      targetList = this.auditLogs;
    }

    const idx = targetList.findIndex(i => i.id === docId || i.uid === docId || i.id === id);
    let currentV = 1;
    let savedDoc: any;

    if (idx >= 0) {
      currentV = (targetList[idx].v || 1) + 1;
      targetList[idx] = {
        ...targetList[idx],
        ...docData,
        id: docId,
        v: currentV,
        updatedAt: timestamp,
      };
      savedDoc = targetList[idx];
    } else {
      const newDoc = {
        ...docData,
        id: docId,
        v: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      targetList.push(newDoc);
      savedDoc = newDoc;
    }

    await this.save();
    return savedDoc;
  }

  public async deleteDocument(collectionName: string, id: string): Promise<boolean> {
    let targetList: any[];
    if (collectionName === "records" || collectionName === "members") {
      targetList = this.records;
    } else if (collectionName === "users") {
      targetList = this.users;
    } else if (collectionName === "payments") {
      targetList = this.payments;
    } else {
      targetList = this.auditLogs;
    }

    const initialLen = targetList.length;
    const filtered = targetList.filter(i => i.id !== id && i.uid !== id);
    if (filtered.length !== initialLen) {
      if (collectionName === "records" || collectionName === "members") {
        this.records = filtered;
      } else if (collectionName === "users") {
        this.users = filtered;
      } else if (collectionName === "payments") {
        this.payments = filtered;
      } else {
        this.auditLogs = filtered;
      }

      await this.save();
      return true;
    }
    return false;
  }

  public logSecurityEvent(event: any) {
    const timestamp = new Date().toISOString();
    const id = "sec-" + crypto.randomUUID().slice(0, 10);
    const auditDoc = {
      id,
      ...event,
      createdAt: timestamp,
    };
    this.auditLogs.push(auditDoc);
    this.save();
  }

  public createBackupSnapshot(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(BACKUP_DIR, `json_database_backup_${timestamp}.json`);
    const snapshotData = {
      records: this.records,
      users: this.users,
      payments: this.payments,
      auditLogs: this.auditLogs,
      timestamp: new Date().toISOString(),
      version: this.version,
    };
    atomicWriteJsonSync(backupFile, snapshotData);
    return backupFile;
  }

  public listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json"));
    return files.map(filename => {
      const filepath = path.join(BACKUP_DIR, filename);
      const stat = fs.statSync(filepath);
      return {
        filename,
        size: stat.size,
        sizeFormatted: (stat.size / 1024).toFixed(2) + " KB",
        created: stat.mtime.toISOString(),
      };
    }).sort((a, b) => b.created.localeCompare(a.created));
  }

  public getStats() {
    const size = fs.existsSync(RECORDS_FILE) ? fs.statSync(RECORDS_FILE).size : 0;
    return {
      totalRecords: this.records.length,
      totalUsers: this.users.length,
      totalPayments: this.payments.length,
      totalAuditLogs: this.auditLogs.length,
      databaseSizeBytes: size,
      databaseSizeFormatted: (size / 1024).toFixed(2) + " KB",
      maxStorageCapacity: "Unlimited Self-Sustaining JSON Storage",
      status: "ONLINE_SYNCHRONIZED_JSON_AUTHORITY",
      version: this.version,
      lastModified: this.lastModified,
      storageEngine: "Self-Sustaining Atomic JSON Storage Engine (siara-maina-clan-data.json)",
    };
  }
}

export const dbEngine = new SelfSustainingJsonDatabaseEngine();

export function parseDeviceInfo(ua: string = "", ip: string = "") {
  let deviceType: "Desktop" | "Mobile" | "Tablet" | "Unknown" = "Desktop";
  let browser = "Chrome";
  let os = "Windows / Linux";

  const lower = ua.toLowerCase();
  if (lower.includes("mobile") || lower.includes("android") || lower.includes("iphone")) {
    deviceType = "Mobile";
  } else if (lower.includes("ipad") || lower.includes("tablet")) {
    deviceType = "Tablet";
  }

  if (lower.includes("windows")) os = "Windows 11/10";
  else if (lower.includes("macintosh") || lower.includes("mac os")) os = "macOS";
  else if (lower.includes("android")) os = "Android OS";
  else if (lower.includes("iphone")) os = "iOS";
  else if (lower.includes("linux")) os = "Linux";

  if (lower.includes("edg/")) browser = "Edge";
  else if (lower.includes("chrome") && !lower.includes("edg/")) browser = "Chrome";
  else if (lower.includes("firefox")) browser = "Firefox";
  else if (lower.includes("safari") && !lower.includes("chrome")) browser = "Safari";

  return { deviceType, browser, os, geoRegion: "Tanzania / Global Cloud" };
}
