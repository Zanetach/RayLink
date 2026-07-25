import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createRuntimePassword,
  createSessionSecret,
  createShadowsocksKey,
  hashPassword,
  hashSessionSecret,
  verifyPassword
} from "./security.js";

const seedPlans = [
  {
    id: "standard",
    name: "标准访问",
    quotaGb: 120,
    deviceLimit: 3,
    nodeScope: ["tokyo", "singapore"],
    clientFormats: ["mihomo", "sing-box"],
    description: "适合日常办公和开发",
    tone: "standard"
  },
  {
    id: "high-speed",
    name: "高速访问",
    quotaGb: 320,
    deviceLimit: 5,
    nodeScope: ["all"],
    clientFormats: ["mihomo", "sing-box", "download"],
    description: "面向高流量研发团队",
    tone: "premium"
  },
  {
    id: "temporary",
    name: "临时访问",
    quotaGb: 36,
    deviceLimit: 1,
    nodeScope: ["tokyo"],
    clientFormats: ["mihomo", "sing-box"],
    description: "外部协作和短期项目",
    tone: "temporary"
  }
];

const seedUsers = [
  ["林知夏", "LZ", "lin.zhixia@meridian-log.cn", "active", "active", 74.3, "standard", "2026-10-18"],
  ["岡本和也", "OK", "k.okamoto@hokkaido-ceramics.jp", "active", "warning", 104.8, "standard", "2026-08-04"],
  ["Priya Mehta", "PM", "priya@vantage-bioworks.in", "active", "active", 75.4, "high-speed", "2026-09-01"],
  ["Nia Okafor", "NO", "nia@lagos-fieldworks.ng", "active", "active", 46.8, "standard", "2026-11-23"],
  ["Lars Eriksson", "LE", "lars@nordhavn-data.se", "invited", "disabled", 18.2, "temporary", "2026-07-31"],
  ["陈望舒", "CW", "wangshu@lingnan-studio.cn", "active", "warning", 103.7, "standard", "2026-08-12"]
];

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function domainError(code, message, statusCode = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validatePlanCapabilities(nodeScope, clientFormats) {
  if (
    !Array.isArray(nodeScope)
    || nodeScope.length === 0
    || nodeScope.some((scope) => !/^(?:all|[a-z0-9][a-z0-9-]{1,31})$/.test(String(scope)))
  ) {
    throw domainError("INVALID_NODE_SCOPE", "节点范围必须使用有效的区域标识");
  }
  const supportedFormats = new Set(["mihomo", "sing-box", "download"]);
  if (
    !Array.isArray(clientFormats)
    || !clientFormats.includes("sing-box")
    || clientFormats.some((format) => !supportedFormats.has(format))
  ) {
    throw domainError("INVALID_CLIENT_FORMATS", "当前方案必须包含 sing-box 客户端格式");
  }
}

function userFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    initials: row.initials,
    email: row.email,
    portalStatus: row.portal_status,
    state: row.state,
    usedGb: row.used_gb,
    planId: row.plan_id,
    expiresAt: row.expires_at
  };
}

export class RayLinkStore {
  constructor({ dbPath, adminUsername, adminPassword, initialHostAddress = "127.0.0.1" }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.seed({ adminUsername, adminPassword, initialHostAddress });
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        secret_hash TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        secret_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        quota_gb REAL NOT NULL CHECK (quota_gb > 0),
        device_limit INTEGER NOT NULL CHECK (device_limit > 0),
        node_scope_json TEXT NOT NULL,
        client_formats_json TEXT NOT NULL,
        description TEXT NOT NULL,
        tone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        initials TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        portal_status TEXT NOT NULL CHECK (portal_status IN ('active', 'invited')),
        state TEXT NOT NULL CHECK (state IN ('active', 'warning', 'disabled')),
        used_gb REAL NOT NULL DEFAULT 0 CHECK (used_gb >= 0),
        plan_id TEXT NOT NULL REFERENCES plans(id),
        expires_at TEXT NOT NULL,
        runtime_uuid TEXT NOT NULL UNIQUE,
        runtime_password TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        region TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        error_json TEXT,
        created_at TEXT NOT NULL,
        published_at TEXT
      );
    `);
  }

  seed({ adminUsername, adminPassword, initialHostAddress }) {
    const createdAt = nowIso();
    const insertAdmin = this.db.prepare(`
      INSERT OR IGNORE INTO admins (id, username, password_hash, created_at)
      VALUES (?, ?, ?, ?)
    `);
    insertAdmin.run(randomUUID(), adminUsername, hashPassword(adminPassword), createdAt);

    const insertPlan = this.db.prepare(`
      INSERT OR IGNORE INTO plans (
        id, name, quota_gb, device_limit, node_scope_json, client_formats_json,
        description, tone, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const plan of seedPlans) {
      insertPlan.run(
        plan.id,
        plan.name,
        plan.quotaGb,
        plan.deviceLimit,
        JSON.stringify(plan.nodeScope),
        JSON.stringify(plan.clientFormats),
        plan.description,
        plan.tone,
        createdAt,
        createdAt
      );
    }

    const insertUser = this.db.prepare(`
      INSERT OR IGNORE INTO users (
        id, name, initials, email, password_hash, portal_status, state, used_gb,
        plan_id, expires_at, runtime_uuid, runtime_password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [name, initials, email, portalStatus, state, usedGb, planId, expiresAt] of seedUsers) {
      insertUser.run(
        randomUUID(),
        name,
        initials,
        email,
        hashPassword("raylink-demo"),
        portalStatus,
        state,
        usedGb,
        planId,
        expiresAt,
        randomUUID(),
        createShadowsocksKey(),
        createdAt,
        createdAt
      );
    }

    this.db.prepare(`
      INSERT OR IGNORE INTO hosts (id, name, address, region, status, created_at, updated_at)
      VALUES ('local', '本机 Runtime', ?, 'tokyo', 'unknown', ?, ?)
    `).run(initialHostAddress, createdAt, createdAt);
    this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES ('shadowsocks_master_password', ?, ?)
    `).run(createShadowsocksKey(), createdAt);
  }

  authenticateAdmin(username, password) {
    const admin = this.db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
    if (!admin || !verifyPassword(password, admin.password_hash)) return null;
    return { id: admin.id, username: admin.username };
  }

  createAdminSession(adminId, ttlSeconds = 43_200) {
    const secret = createSessionSecret();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO sessions (secret_hash, admin_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(hashSessionSecret(secret), adminId, expiresAt, nowIso());
    return { secret, expiresAt };
  }

  adminForSession(secret) {
    if (!secret) return null;
    return this.db.prepare(`
      SELECT admins.id, admins.username
      FROM sessions
      JOIN admins ON admins.id = sessions.admin_id
      WHERE sessions.secret_hash = ? AND sessions.expires_at > ?
    `).get(hashSessionSecret(secret), nowIso()) || null;
  }

  authenticateUser(email, password) {
    const user = this.db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
    if (!user || !verifyPassword(password, user.password_hash)) return null;
    return {
      id: user.id,
      email: user.email,
      portalStatus: user.portal_status
    };
  }

  createUserSession(userId, ttlSeconds = 43_200) {
    const secret = createSessionSecret();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO user_sessions (secret_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(hashSessionSecret(secret), userId, expiresAt, nowIso());
    return { secret, expiresAt };
  }

  userForSession(secret) {
    if (!secret) return null;
    return this.db.prepare(`
      SELECT users.id
      FROM user_sessions
      JOIN users ON users.id = user_sessions.user_id
      WHERE user_sessions.secret_hash = ? AND user_sessions.expires_at > ?
    `).get(hashSessionSecret(secret), nowIso()) || null;
  }

  portalProfile(userId) {
    const row = this.db.prepare(`
      SELECT users.id, users.name, users.initials, users.email, users.portal_status,
             users.state, users.used_gb, users.plan_id, users.expires_at,
             plans.name AS plan_name, plans.quota_gb, plans.device_limit,
             plans.node_scope_json, plans.client_formats_json, plans.description
      FROM users
      JOIN plans ON plans.id = users.plan_id
      WHERE users.id = ?
    `).get(userId);
    if (!row) return null;
    return {
      user: userFromRow(row),
      plan: {
        id: row.plan_id,
        name: row.plan_name,
        quotaGb: row.quota_gb,
        deviceLimit: row.device_limit,
        nodeScope: parseJson(row.node_scope_json, []),
        clientFormats: parseJson(row.client_formats_json, []),
        description: row.description
      }
    };
  }

  clientCredential(userId) {
    const row = this.db.prepare(`
      SELECT users.email, users.runtime_password, users.state, users.expires_at, plans.node_scope_json
      FROM users
      JOIN plans ON plans.id = users.plan_id
      WHERE users.id = ?
    `).get(userId);
    if (!row) return null;
    return {
      email: row.email,
      runtimePassword: row.runtime_password,
      state: row.state,
      expiresAt: row.expires_at,
      nodeScope: parseJson(row.node_scope_json, [])
    };
  }

  listPlans() {
    return this.db.prepare(`
      SELECT plans.*, COUNT(users.id) AS assigned_users
      FROM plans
      LEFT JOIN users ON users.plan_id = plans.id
      GROUP BY plans.id
      ORDER BY plans.created_at, plans.id
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      quotaGb: row.quota_gb,
      deviceLimit: row.device_limit,
      nodeScope: parseJson(row.node_scope_json, []),
      clientFormats: parseJson(row.client_formats_json, []),
      assignedUsers: Number(row.assigned_users),
      description: row.description,
      tone: row.tone
    }));
  }

  listUsers() {
    return this.db.prepare(`
      SELECT id, name, initials, email, portal_status, state, used_gb, plan_id, expires_at
      FROM users
      ORDER BY created_at, name
    `).all().map(userFromRow);
  }

  listHosts() {
    return this.db.prepare("SELECT id, name, address, region, status FROM hosts ORDER BY created_at").all();
  }

  getHost(id) {
    return this.db.prepare("SELECT id, name, address, region, status FROM hosts WHERE id = ?").get(id) || null;
  }

  updateHost(id, input) {
    const current = this.getHost(id);
    if (!current) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const next = {
      name: input.name === undefined ? current.name : String(input.name).trim(),
      address: input.address === undefined ? current.address : String(input.address).trim(),
      region: input.region === undefined ? current.region : String(input.region).trim()
    };
    if (!next.name) throw domainError("INVALID_HOST_NAME", "主机名称不能为空");
    if (!/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:]+\])$/i.test(next.address)) {
      throw domainError("INVALID_HOST_ADDRESS", "请输入有效的主机域名或 IP 地址");
    }
    if (!/^[a-z0-9-]{2,32}$/i.test(next.region)) {
      throw domainError("INVALID_HOST_REGION", "区域标识格式不正确");
    }
    this.db.prepare(`
      UPDATE hosts SET name = ?, address = ?, region = ?, updated_at = ? WHERE id = ?
    `).run(next.name, next.address, next.region, nowIso(), id);
    return this.getHost(id);
  }

  bootstrap(admin) {
    return {
      currentAdmin: { id: admin.id, username: admin.username },
      users: this.listUsers(),
      plans: this.listPlans(),
      hosts: this.listHosts()
    };
  }

  createPlan(input) {
    const id = String(input.id || "").trim();
    const name = String(input.name || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) {
      throw domainError("INVALID_PLAN_ID", "方案 ID 必须为 2 到 32 位小写字母、数字或连字符");
    }
    if (!name) throw domainError("INVALID_PLAN_NAME", "方案名称不能为空");
    if (!Number.isFinite(input.quotaGb) || input.quotaGb <= 0) {
      throw domainError("INVALID_QUOTA", "流量额度必须大于 0");
    }
    if (!Number.isInteger(input.deviceLimit) || input.deviceLimit <= 0) {
      throw domainError("INVALID_DEVICE_LIMIT", "设备上限必须为正整数");
    }
    validatePlanCapabilities(input.nodeScope, input.clientFormats);

    const timestamp = nowIso();
    try {
      this.db.prepare(`
        INSERT INTO plans (
          id, name, quota_gb, device_limit, node_scope_json, client_formats_json,
          description, tone, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        name,
        input.quotaGb,
        input.deviceLimit,
        JSON.stringify(input.nodeScope),
        JSON.stringify(input.clientFormats),
        String(input.description || "自定义服务方案").trim(),
        String(input.tone || "standard"),
        timestamp,
        timestamp
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw domainError("PLAN_EXISTS", "方案 ID 已存在", 409);
      }
      throw error;
    }
    return this.listPlans().find((plan) => plan.id === id);
  }

  updatePlan(id, input) {
    const current = this.listPlans().find((plan) => plan.id === id);
    if (!current) throw domainError("PLAN_NOT_FOUND", "方案不存在", 404);
    const next = {
      name: input.name === undefined ? current.name : String(input.name).trim(),
      quotaGb: input.quotaGb === undefined ? current.quotaGb : input.quotaGb,
      deviceLimit: input.deviceLimit === undefined ? current.deviceLimit : input.deviceLimit,
      nodeScope: input.nodeScope === undefined ? current.nodeScope : input.nodeScope,
      clientFormats: input.clientFormats === undefined ? current.clientFormats : input.clientFormats,
      description: input.description === undefined ? current.description : String(input.description).trim(),
      tone: input.tone === undefined ? current.tone : String(input.tone)
    };
    if (!next.name) throw domainError("INVALID_PLAN_NAME", "方案名称不能为空");
    if (!Number.isFinite(next.quotaGb) || next.quotaGb <= 0) {
      throw domainError("INVALID_QUOTA", "流量额度必须大于 0");
    }
    if (!Number.isInteger(next.deviceLimit) || next.deviceLimit <= 0) {
      throw domainError("INVALID_DEVICE_LIMIT", "设备上限必须为正整数");
    }
    validatePlanCapabilities(next.nodeScope, next.clientFormats);
    this.db.prepare(`
      UPDATE plans
      SET name = ?, quota_gb = ?, device_limit = ?, node_scope_json = ?,
          client_formats_json = ?, description = ?, tone = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.quotaGb,
      next.deviceLimit,
      JSON.stringify(next.nodeScope),
      JSON.stringify(next.clientFormats),
      next.description,
      next.tone,
      nowIso(),
      id
    );
    return this.listPlans().find((plan) => plan.id === id);
  }

  createUser(input) {
    const name = String(input.name || "").trim();
    const email = String(input.email || "").trim().toLowerCase();
    const planId = String(input.planId || "");
    if (!name) throw domainError("INVALID_USER_NAME", "用户名称不能为空");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw domainError("INVALID_EMAIL", "邮箱地址格式不正确");
    }
    if (!this.db.prepare("SELECT 1 FROM plans WHERE id = ?").get(planId)) {
      throw domainError("PLAN_NOT_FOUND", "分配的方案不存在");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.expiresAt || ""))) {
      throw domainError("INVALID_EXPIRY", "到期时间格式必须为 YYYY-MM-DD");
    }
    const portalStatus = input.portalStatus === undefined ? "invited" : String(input.portalStatus);
    if (!["active", "invited"].includes(portalStatus)) {
      throw domainError("INVALID_PORTAL_STATUS", "用户中心状态不正确");
    }
    if (input.password !== undefined && String(input.password).length < 8) {
      throw domainError("INVALID_PASSWORD", "用户中心密码至少需要 8 位");
    }

    const id = randomUUID();
    const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "新";
    const timestamp = nowIso();
    try {
      this.db.prepare(`
        INSERT INTO users (
          id, name, initials, email, password_hash, portal_status, state, used_gb,
          plan_id, expires_at, runtime_uuid, runtime_password, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        name,
        initials,
        email,
        hashPassword(input.password || createRuntimePassword(12)),
        portalStatus,
        planId,
        input.expiresAt,
        randomUUID(),
        createShadowsocksKey(),
        timestamp,
        timestamp
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw domainError("USER_EXISTS", "邮箱已经存在", 409);
      }
      throw error;
    }
    return this.getUser(id);
  }

  getUser(id) {
    const row = this.db.prepare(`
      SELECT id, name, initials, email, portal_status, state, used_gb, plan_id, expires_at
      FROM users WHERE id = ?
    `).get(id);
    return row ? userFromRow(row) : null;
  }

  updateUser(id, input) {
    const current = this.getUser(id);
    if (!current) throw domainError("USER_NOT_FOUND", "用户不存在", 404);
    const next = {
      name: input.name === undefined ? current.name : String(input.name).trim(),
      email: input.email === undefined ? current.email : String(input.email).trim().toLowerCase(),
      planId: input.planId === undefined ? current.planId : String(input.planId),
      expiresAt: input.expiresAt === undefined ? current.expiresAt : String(input.expiresAt),
      state: input.state === undefined ? current.state : String(input.state),
      portalStatus: input.portalStatus === undefined ? current.portalStatus : String(input.portalStatus)
    };
    if (!next.name) throw domainError("INVALID_USER_NAME", "用户名称不能为空");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
      throw domainError("INVALID_EMAIL", "邮箱地址格式不正确");
    }
    if (!this.db.prepare("SELECT 1 FROM plans WHERE id = ?").get(next.planId)) {
      throw domainError("PLAN_NOT_FOUND", "分配的方案不存在");
    }
    if (!["active", "warning", "disabled"].includes(next.state)) {
      throw domainError("INVALID_USER_STATE", "用户状态不正确");
    }
    if (!["active", "invited"].includes(next.portalStatus)) {
      throw domainError("INVALID_PORTAL_STATUS", "用户中心状态不正确");
    }
    if (input.password !== undefined && String(input.password).length < 8) {
      throw domainError("INVALID_PASSWORD", "用户中心密码至少需要 8 位");
    }
    const initials = next.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || current.initials;
    try {
      this.db.prepare(`
        UPDATE users
        SET name = ?, initials = ?, email = ?, plan_id = ?, expires_at = ?,
            state = ?, portal_status = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.name,
        initials,
        next.email,
        next.planId,
        next.expiresAt,
        next.state,
        next.portalStatus,
        nowIso(),
        id
      );
      if (input.password !== undefined) {
        this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
          .run(hashPassword(String(input.password)), id);
      }
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw domainError("USER_EXISTS", "邮箱已经存在", 409);
      }
      throw error;
    }
    return this.getUser(id);
  }

  runtimeSnapshot() {
    const host = this.db.prepare("SELECT id, name, address, region, status FROM hosts WHERE id = 'local'").get();
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'shadowsocks_master_password'").get();
    const users = this.db.prepare(`
      SELECT users.email, users.state, users.expires_at, users.runtime_password, plans.node_scope_json
      FROM users
      JOIN plans ON plans.id = users.plan_id
      ORDER BY users.email
    `).all().map((row) => ({
      email: row.email,
      state: row.state,
      expiresAt: row.expires_at,
      runtimePassword: row.runtime_password,
      nodeScope: parseJson(row.node_scope_json, [])
    }));
    return {
      host,
      masterPassword: setting.value,
      users
    };
  }

  createDeployment({ version, configJson, checksum, eligibleUsers }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO deployments (id, version, status, config_json, error_json, created_at, published_at)
      VALUES (?, ?, 'validating', ?, NULL, ?, NULL)
    `).run(id, version, JSON.stringify({ config: configJson, checksum, eligibleUsers }), nowIso());
    return id;
  }

  finishDeployment(id, { status, error = null }) {
    this.db.prepare(`
      UPDATE deployments
      SET status = ?, error_json = ?, published_at = ?
      WHERE id = ?
    `).run(status, error ? JSON.stringify({ message: error }) : null, status === "active" ? nowIso() : null, id);
  }

  listDeployments(limit = 20) {
    return this.db.prepare(`
      SELECT id, version, status, config_json, error_json, created_at, published_at
      FROM deployments
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit).map((row) => {
      const metadata = parseJson(row.config_json, {});
      const error = parseJson(row.error_json, null);
      return {
        id: row.id,
        version: row.version,
        status: row.status,
        checksum: metadata.checksum,
        eligibleUsers: metadata.eligibleUsers,
        error: error?.message || null,
        createdAt: row.created_at,
        publishedAt: row.published_at
      };
    });
  }

  close() {
    this.db.close();
  }
}
