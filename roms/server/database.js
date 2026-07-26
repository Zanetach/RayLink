import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createRuntimePassword,
  createSessionSecret,
  createShadowsocksKey,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashSessionSecret,
  verifyPassword
} from "./security.js";
import {
  assertProtocolSet,
  defaultProtocolConfigs,
  normalizeProtocolConfig,
  normalizeProtocolConfigs
} from "./singbox/protocol-catalog.js";

const seedPlans = [
  {
    id: "standard",
    name: "标准访问",
    quotaGb: 120,
    legacyDeviceLimit: 3,
    nodeScope: ["tokyo", "singapore"],
    clientFormats: ["mihomo", "sing-box"],
    description: "适合日常办公和开发",
    tone: "standard"
  },
  {
    id: "high-speed",
    name: "高速访问",
    quotaGb: 320,
    legacyDeviceLimit: 5,
    nodeScope: ["all"],
    clientFormats: ["mihomo", "sing-box", "download"],
    description: "面向高流量研发团队",
    tone: "premium"
  },
  {
    id: "temporary",
    name: "临时访问",
    quotaGb: 36,
    legacyDeviceLimit: 1,
    nodeScope: ["tokyo"],
    clientFormats: ["mihomo", "sing-box"],
    description: "外部协作和短期项目",
    tone: "temporary"
  }
];

const LEGACY_ENTITLEMENT_PLAN_ID = "user-entitlement";
const GIBIBYTE = 1024 ** 3;

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

function validateUserEntitlement({ quotaGb, nodeScope, clientFormats }) {
  if (!Number.isFinite(quotaGb) || quotaGb <= 0) {
    throw domainError("INVALID_QUOTA", "流量额度必须大于 0");
  }
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
    throw domainError("INVALID_CLIENT_FORMATS", "用户权益必须包含 sing-box 客户端格式");
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
    usedGb: row.used_bytes === null || row.used_bytes === undefined
      ? row.used_gb
      : Number(row.used_bytes) / GIBIBYTE,
    quotaGb: row.quota_gb,
    nodeScope: parseJson(row.node_scope_json, []),
    clientFormats: parseJson(row.client_formats_json, []),
    expiresAt: row.expires_at,
    subscription: {
      publicId: row.subscription_public_id || null,
      configured: Boolean(row.subscription_secret_hash)
    }
  };
}

function finiteMetric(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function normalizeTelemetry(input = {}) {
  const serviceStatus = ["running", "staged", "stopped", "failed", "unknown"].includes(input.serviceStatus)
    ? input.serviceStatus
    : "unknown";
  return {
    cpuPercent: finiteMetric(input.cpuPercent, 0, 100),
    memoryUsedBytes: finiteMetric(input.memoryUsedBytes, 0, Number.MAX_SAFE_INTEGER),
    memoryTotalBytes: finiteMetric(input.memoryTotalBytes, 1, Number.MAX_SAFE_INTEGER),
    networkRxBytes: finiteMetric(input.networkRxBytes, 0, Number.MAX_SAFE_INTEGER),
    networkTxBytes: finiteMetric(input.networkTxBytes, 0, Number.MAX_SAFE_INTEGER),
    networkRxBps: finiteMetric(input.networkRxBps, 0, Number.MAX_SAFE_INTEGER),
    networkTxBps: finiteMetric(input.networkTxBps, 0, Number.MAX_SAFE_INTEGER),
    serviceStatus
  };
}

function hostFromRow(row) {
  const lastSeenAt = row.last_seen_at || null;
  const buildTags = parseJson(row.build_tags_json, []);
  const latestUpgradePayload = parseJson(row.latest_upgrade_payload_json, {}) || {};
  const latestUpgradeEnvelope = parseJson(row.latest_upgrade_result_json, {}) || {};
  const latestUpgradeResult = latestUpgradeEnvelope.result || {};
  const remoteOffline = (row.kind || "local") === "remote"
    && lastSeenAt
    && Date.now() - new Date(lastSeenAt).getTime() > 45_000;
  const usageSupported = buildTags.includes("with_v2ray_api");
  const usageLastSampleAt = row.usage_last_sample_at || null;
  const usageLastErrorAt = row.usage_last_error_at || null;
  const usageErrorIsCurrent = usageLastErrorAt
    && (!usageLastSampleAt || new Date(usageLastErrorAt) > new Date(usageLastSampleAt));
  const usageStale = usageLastSampleAt
    && Date.now() - new Date(usageLastSampleAt).getTime() > 2 * 60_000;
  const usageStatus = !usageSupported
    ? "unsupported"
    : usageErrorIsCurrent
      ? "error"
      : !usageLastSampleAt
        ? "awaiting-sample"
        : usageStale
          ? "stale"
          : "healthy";
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    region: row.region,
    status: remoteOffline ? "offline" : row.status,
    kind: row.kind || "local",
    hostname: row.hostname || null,
    platform: row.platform || null,
    architecture: row.architecture || null,
    agentVersion: row.agent_version || null,
    runtimeVersion: row.runtime_version || null,
    buildTags,
    assetEncryptionReady: Boolean(row.encryption_public_key),
    usageMetering: {
      supported: usageSupported,
      source: usageSupported ? "v2ray-api" : null,
      status: usageStatus,
      lastSampleAt: usageLastSampleAt,
      lastError: usageErrorIsCurrent ? row.usage_last_error || null : null,
      lastErrorAt: usageLastErrorAt
    },
    lastSeenAt,
    enrolledAt: row.enrolled_at || null,
    telemetry: {
      cpuPercent: row.cpu_percent ?? null,
      memoryUsedBytes: row.memory_used_bytes ?? null,
      memoryTotalBytes: row.memory_total_bytes ?? null,
      networkRxBytes: row.network_rx_bytes ?? null,
      networkTxBytes: row.network_tx_bytes ?? null,
      networkRxBps: row.network_rx_bps ?? null,
      networkTxBps: row.network_tx_bps ?? null,
      serviceStatus: row.service_status || "unknown",
      updatedAt: row.metrics_updated_at || null
    },
    deploymentSync: {
      pendingTaskCount: Number(row.pending_task_count || 0),
      critical: Boolean(row.critical_pending),
      status: Number(row.pending_task_count || 0) > 0
        ? row.critical_pending ? "revocation-pending" : "pending"
        : "current"
    },
    runtimeUpgrade: {
      pending: Number(row.pending_upgrade_count || 0) > 0,
      status: Number(row.pending_upgrade_count || 0) > 0
        ? "pending"
        : row.latest_upgrade_status || "never",
      targetVersion: latestUpgradePayload.targetVersion || null,
      previousVersion: latestUpgradeResult.previousVersion || null,
      runtimeVersion: latestUpgradeResult.runtimeVersion || null,
      rolledBack: typeof latestUpgradeResult.rolledBack === "boolean"
        ? latestUpgradeResult.rolledBack
        : null,
      packageMetadataRestored: typeof latestUpgradeResult.packageMetadataRestored === "boolean"
        ? latestUpgradeResult.packageMetadataRestored
        : null,
      error: latestUpgradeResult.error || null,
      finishedAt: row.latest_upgrade_finished_at || null
    }
  };
}

function normalizedHostInput(input, current = {}) {
  const host = {
    name: input.name === undefined ? current.name : String(input.name).trim(),
    address: input.address === undefined ? current.address : String(input.address).trim(),
    region: input.region === undefined ? current.region : String(input.region).trim()
  };
  if (!host.name) throw domainError("INVALID_HOST_NAME", "主机名称不能为空");
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:]+\])$/i.test(host.address)) {
    throw domainError("INVALID_HOST_ADDRESS", "请输入有效的主机域名或 IP 地址");
  }
  if (!/^[a-z0-9-]{2,32}$/i.test(host.region)) {
    throw domainError("INVALID_HOST_REGION", "区域标识格式不正确");
  }
  return host;
}

export class RayLinkStore {
  constructor({
    dbPath,
    adminUsername,
    adminPassword,
    initialHostAddress = "127.0.0.1",
    initialListenPort = 8388,
    seedDemoData = true,
    nodeTaskRetryBaseMs = 60_000
  }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.lastTelemetryPruneAt = 0;
    this.nodeTaskRetryBaseMs = Math.max(0, Number(nodeTaskRetryBaseMs) || 0);
    this.migrate();
    this.seed({ adminUsername, adminPassword, initialHostAddress, initialListenPort, seedDemoData });
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
        used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
        plan_id TEXT NOT NULL REFERENCES plans(id),
        quota_gb REAL NOT NULL CHECK (quota_gb > 0),
        device_limit INTEGER NOT NULL CHECK (device_limit > 0),
        node_scope_json TEXT NOT NULL,
        client_formats_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        runtime_uuid TEXT NOT NULL UNIQUE,
        runtime_password TEXT NOT NULL,
        subscription_public_id TEXT,
        subscription_secret_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        region TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'local',
        enrollment_secret_hash TEXT,
        node_secret_hash TEXT,
        hostname TEXT,
        platform TEXT,
        architecture TEXT,
        agent_version TEXT,
        runtime_version TEXT,
        build_tags_json TEXT NOT NULL DEFAULT '[]',
        encryption_public_key TEXT,
        usage_last_sample_at TEXT,
        usage_last_error TEXT,
        usage_last_error_at TEXT,
        last_seen_at TEXT,
        enrolled_at TEXT,
        cpu_percent REAL,
        memory_used_bytes INTEGER,
        memory_total_bytes INTEGER,
        network_rx_bytes INTEGER,
        network_tx_bytes INTEGER,
        network_rx_bps REAL,
        network_tx_bps REAL,
        service_status TEXT,
        metrics_updated_at TEXT,
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
        publisher_admin_id TEXT,
        created_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE TABLE IF NOT EXISTS node_tasks (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
        result_json TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS node_tasks_host_status_created
      ON node_tasks(host_id, status, created_at);
      CREATE TABLE IF NOT EXISTS host_metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        cpu_percent REAL,
        memory_used_bytes INTEGER,
        memory_total_bytes INTEGER,
        network_rx_bytes INTEGER,
        network_tx_bytes INTEGER,
        network_rx_bps REAL,
        network_tx_bps REAL,
        service_status TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS host_metric_samples_host_recorded
      ON host_metric_samples(host_id, recorded_at);
      CREATE INDEX IF NOT EXISTS host_metric_samples_recorded
      ON host_metric_samples(recorded_at);
      CREATE TABLE IF NOT EXISTS usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        sample_id TEXT NOT NULL,
        runtime_instance_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(host_id, sample_id)
      );
      CREATE TABLE IF NOT EXISTS usage_counter_checkpoints (
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        user_name TEXT NOT NULL,
        runtime_instance_id TEXT NOT NULL,
        uplink_bytes INTEGER NOT NULL,
        downlink_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(host_id, user_name)
      );
      CREATE TABLE IF NOT EXISTS user_usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_id INTEGER NOT NULL REFERENCES usage_samples(id) ON DELETE CASCADE,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uplink_bytes INTEGER NOT NULL,
        downlink_bytes INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_usage_ledger_user_recorded
      ON user_usage_ledger(user_id, recorded_at);
    `);
    const deploymentColumns = this.db.prepare("PRAGMA table_info(deployments)").all();
    if (!deploymentColumns.some((column) => column.name === "publisher_admin_id")) {
      this.db.exec("ALTER TABLE deployments ADD COLUMN publisher_admin_id TEXT");
    }
    const nodeTaskColumns = this.db.prepare("PRAGMA table_info(node_tasks)").all();
    const nodeTaskMigrations = [
      ["priority", "INTEGER NOT NULL DEFAULT 0"],
      ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
      ["max_attempts", "INTEGER NOT NULL DEFAULT 5"],
      ["next_attempt_at", "TEXT"]
    ];
    for (const [column, definition] of nodeTaskMigrations) {
      if (!nodeTaskColumns.some((candidate) => candidate.name === column)) {
        this.db.exec(`ALTER TABLE node_tasks ADD COLUMN ${column} ${definition}`);
      }
    }
    const userColumns = this.db.prepare("PRAGMA table_info(users)").all();
    if (!userColumns.some((column) => column.name === "used_bytes")) {
      this.db.exec("ALTER TABLE users ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`
        UPDATE users
        SET used_bytes = CAST(ROUND(used_gb * ${GIBIBYTE}) AS INTEGER)
      `);
    }
    if (!userColumns.some((column) => column.name === "quota_gb")) {
      this.db.exec("ALTER TABLE users ADD COLUMN quota_gb REAL");
    }
    if (!userColumns.some((column) => column.name === "device_limit")) {
      this.db.exec("ALTER TABLE users ADD COLUMN device_limit INTEGER");
    }
    if (!userColumns.some((column) => column.name === "node_scope_json")) {
      this.db.exec("ALTER TABLE users ADD COLUMN node_scope_json TEXT");
    }
    if (!userColumns.some((column) => column.name === "client_formats_json")) {
      this.db.exec("ALTER TABLE users ADD COLUMN client_formats_json TEXT");
    }
    if (!userColumns.some((column) => column.name === "subscription_public_id")) {
      this.db.exec("ALTER TABLE users ADD COLUMN subscription_public_id TEXT");
    }
    if (!userColumns.some((column) => column.name === "subscription_secret_hash")) {
      this.db.exec("ALTER TABLE users ADD COLUMN subscription_secret_hash TEXT");
    }
    this.db.exec(`
      UPDATE users
      SET subscription_public_id = lower(hex(randomblob(16)))
      WHERE subscription_public_id IS NULL
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_subscription_public_id
      ON users(subscription_public_id)
    `);
    const hostColumns = this.db.prepare("PRAGMA table_info(hosts)").all();
    const hostMigrations = [
      ["kind", "TEXT NOT NULL DEFAULT 'local'"],
      ["enrollment_secret_hash", "TEXT"],
      ["node_secret_hash", "TEXT"],
      ["hostname", "TEXT"],
      ["platform", "TEXT"],
      ["architecture", "TEXT"],
      ["agent_version", "TEXT"],
      ["runtime_version", "TEXT"],
      ["build_tags_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["encryption_public_key", "TEXT"],
      ["usage_last_sample_at", "TEXT"],
      ["usage_last_error", "TEXT"],
      ["usage_last_error_at", "TEXT"],
      ["last_seen_at", "TEXT"],
      ["enrolled_at", "TEXT"],
      ["cpu_percent", "REAL"],
      ["memory_used_bytes", "INTEGER"],
      ["memory_total_bytes", "INTEGER"],
      ["network_rx_bytes", "INTEGER"],
      ["network_tx_bytes", "INTEGER"],
      ["network_rx_bps", "REAL"],
      ["network_tx_bps", "REAL"],
      ["service_status", "TEXT"],
      ["metrics_updated_at", "TEXT"]
    ];
    for (const [column, definition] of hostMigrations) {
      if (!hostColumns.some((candidate) => candidate.name === column)) {
        this.db.exec(`ALTER TABLE hosts ADD COLUMN ${column} ${definition}`);
      }
    }
    this.db.exec(`
      UPDATE users
      SET quota_gb = COALESCE(quota_gb, (SELECT quota_gb FROM plans WHERE plans.id = users.plan_id), 120),
          device_limit = COALESCE(device_limit, (SELECT device_limit FROM plans WHERE plans.id = users.plan_id), 3),
          node_scope_json = COALESCE(node_scope_json, (SELECT node_scope_json FROM plans WHERE plans.id = users.plan_id), '["all"]'),
          client_formats_json = COALESCE(client_formats_json, (SELECT client_formats_json FROM plans WHERE plans.id = users.plan_id), '["sing-box"]')
    `);
  }

  seed({ adminUsername, adminPassword, initialHostAddress, initialListenPort, seedDemoData }) {
    const createdAt = nowIso();
    const insertAdmin = this.db.prepare(`
      INSERT OR IGNORE INTO admins (id, username, password_hash, created_at)
      VALUES (?, ?, ?, ?)
    `);
    insertAdmin.run(randomUUID(), adminUsername, hashPassword(adminPassword), createdAt);

    this.db.prepare(`
      INSERT OR IGNORE INTO plans (
        id, name, quota_gb, device_limit, node_scope_json, client_formats_json,
        description, tone, created_at, updated_at
      ) VALUES (?, '用户独立权益兼容记录', 1, 1, '["all"]', '["sing-box"]', '仅用于旧数据库外键兼容', 'standard', ?, ?)
    `).run(LEGACY_ENTITLEMENT_PLAN_ID, createdAt, createdAt);

    if (seedDemoData) {
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
          plan.legacyDeviceLimit,
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
        id, name, initials, email, password_hash, portal_status, state, used_gb, used_bytes,
        plan_id, quota_gb, device_limit, node_scope_json, client_formats_json,
        expires_at, runtime_uuid, runtime_password, subscription_public_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
      for (const [name, initials, email, portalStatus, state, usedGb, planId, expiresAt] of seedUsers) {
        const entitlement = seedPlans.find((plan) => plan.id === planId);
        insertUser.run(
          randomUUID(),
          name,
          initials,
          email,
          hashPassword("raylink-demo"),
          portalStatus,
          state,
          usedGb,
          Math.round(usedGb * GIBIBYTE),
          planId,
          entitlement.quotaGb,
          entitlement.legacyDeviceLimit,
          JSON.stringify(entitlement.nodeScope),
          JSON.stringify(entitlement.clientFormats),
          expiresAt,
          randomUUID(),
          createShadowsocksKey(),
          createRuntimePassword(18),
          createdAt,
          createdAt
        );
      }
    }

    this.db.prepare(`
      INSERT OR IGNORE INTO hosts (id, name, address, region, status, created_at, updated_at)
      VALUES ('local', 'RayLink Runtime', ?, 'tokyo', 'unknown', ?, ?)
    `).run(initialHostAddress, createdAt, createdAt);
    this.db.prepare(`
      UPDATE hosts SET name = 'RayLink Runtime', updated_at = ?
      WHERE id = 'local' AND name = 'CycleLink Runtime'
    `).run(createdAt);
    this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES ('shadowsocks_master_password', ?, ?)
    `).run(createShadowsocksKey(), createdAt);
    this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES ('runtime_protocols', ?, ?)
    `).run(JSON.stringify(defaultProtocolConfigs(initialListenPort)), createdAt);
  }

  async authenticateAdmin(username, password) {
    const admin = this.db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
    const valid = await verifyPassword(password, admin?.password_hash || DUMMY_PASSWORD_HASH);
    if (!admin || !valid) return null;
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

  async authenticateUser(email, password) {
    const user = this.db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
    const valid = await verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !valid) return null;
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
             users.state, users.used_gb, users.quota_gb,
             users.node_scope_json, users.client_formats_json, users.expires_at,
             users.subscription_public_id, users.subscription_secret_hash
      FROM users
      WHERE users.id = ?
    `).get(userId);
    if (!row) return null;
    return {
      user: userFromRow(row),
      entitlement: {
        quotaGb: row.quota_gb,
        nodeScope: parseJson(row.node_scope_json, []),
        clientFormats: parseJson(row.client_formats_json, [])
      }
    };
  }

  clientCredential(userId) {
    const row = this.db.prepare(`
      SELECT users.email, users.runtime_uuid, users.runtime_password, users.state, users.portal_status,
             users.expires_at, users.used_gb, users.quota_gb, users.node_scope_json,
             users.client_formats_json,
             (SELECT region FROM hosts WHERE id = 'local') AS host_region,
             (SELECT value FROM settings WHERE key = 'shadowsocks_master_password') AS server_password
      FROM users
      WHERE users.id = ?
    `).get(userId);
    if (!row) return null;
    return {
      email: row.email,
      runtimeUuid: row.runtime_uuid,
      runtimePassword: row.runtime_password,
      serverPassword: row.server_password,
      state: row.state,
      portalStatus: row.portal_status,
      expiresAt: row.expires_at,
      usedGb: row.used_gb,
      quotaGb: row.quota_gb,
      nodeScope: parseJson(row.node_scope_json, []),
      clientFormats: parseJson(row.client_formats_json, []),
      hostRegion: row.host_region
    };
  }

  rotateUserSubscription(userId) {
    const user = this.db.prepare(`
      SELECT id, subscription_public_id
      FROM users
      WHERE id = ?
    `).get(userId);
    if (!user) throw domainError("USER_NOT_FOUND", "用户不存在", 404);
    const publicId = user.subscription_public_id || createRuntimePassword(18);
    const secret = createSessionSecret();
    this.db.prepare(`
      UPDATE users
      SET subscription_public_id = ?, subscription_secret_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(publicId, hashSessionSecret(secret), nowIso(), userId);
    return { publicId, secret };
  }

  userForSubscription(publicId, secret) {
    if (!publicId || !secret) return null;
    return this.db.prepare(`
      SELECT id
      FROM users
      WHERE subscription_public_id = ?
        AND subscription_secret_hash = ?
    `).get(publicId, hashSessionSecret(secret)) || null;
  }

  listUsers() {
    return this.db.prepare(`
      SELECT id, name, initials, email, portal_status, state, used_gb, used_bytes, quota_gb,
             node_scope_json, client_formats_json, expires_at,
             subscription_public_id, subscription_secret_hash
      FROM users
      ORDER BY created_at, name
    `).all().map(userFromRow);
  }

  listHosts() {
    return this.db.prepare(`
      SELECT hosts.*,
             SUM(CASE
               WHEN node_tasks.kind = 'publish-config'
                 AND node_tasks.status IN ('pending', 'claimed')
               THEN 1 ELSE 0
             END)
               AS pending_task_count,
             MAX(CASE
               WHEN node_tasks.kind = 'publish-config'
                 AND node_tasks.status IN ('pending', 'claimed')
                 AND node_tasks.priority >= 100
               THEN 1 ELSE 0
             END) AS critical_pending,
             SUM(CASE
               WHEN node_tasks.kind = 'upgrade-runtime'
                 AND node_tasks.status IN ('pending', 'claimed')
               THEN 1 ELSE 0
             END) AS pending_upgrade_count,
             (
               SELECT status FROM node_tasks AS latest_upgrade
               WHERE latest_upgrade.host_id = hosts.id
                 AND latest_upgrade.kind = 'upgrade-runtime'
               ORDER BY latest_upgrade.created_at DESC LIMIT 1
             ) AS latest_upgrade_status,
             (
               SELECT payload_json FROM node_tasks AS latest_upgrade
               WHERE latest_upgrade.host_id = hosts.id
                 AND latest_upgrade.kind = 'upgrade-runtime'
               ORDER BY latest_upgrade.created_at DESC LIMIT 1
             ) AS latest_upgrade_payload_json,
             (
               SELECT result_json FROM node_tasks AS latest_upgrade
               WHERE latest_upgrade.host_id = hosts.id
                 AND latest_upgrade.kind = 'upgrade-runtime'
               ORDER BY latest_upgrade.created_at DESC LIMIT 1
             ) AS latest_upgrade_result_json,
             (
               SELECT finished_at FROM node_tasks AS latest_upgrade
               WHERE latest_upgrade.host_id = hosts.id
                 AND latest_upgrade.kind = 'upgrade-runtime'
               ORDER BY latest_upgrade.created_at DESC LIMIT 1
             ) AS latest_upgrade_finished_at
      FROM hosts
      LEFT JOIN node_tasks ON node_tasks.host_id = hosts.id
      GROUP BY hosts.id
      ORDER BY hosts.created_at
    `).all().map(hostFromRow);
  }

  recordUsageSnapshot(hostId, input = {}) {
    const host = this.getHost(hostId);
    if (!host) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const sampleId = String(input.sampleId || "");
    const runtimeInstanceId = String(input.runtimeInstanceId || "");
    if (!/^[a-zA-Z0-9_.:-]{8,160}$/.test(sampleId)) {
      throw domainError("INVALID_USAGE_SAMPLE", "流量样本编号无效");
    }
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(runtimeInstanceId)) {
      throw domainError("INVALID_RUNTIME_INSTANCE", "Runtime 实例编号无效");
    }
    if (!Array.isArray(input.users) || input.users.length > 10_000) {
      throw domainError("INVALID_USAGE_SAMPLE", "流量样本用户列表无效");
    }
    const observedAt = new Date(input.observedAt || Date.now());
    if (!Number.isFinite(observedAt.getTime())) {
      throw domainError("INVALID_USAGE_SAMPLE", "流量样本时间无效");
    }
    const normalized = input.users.map((usage) => {
      const userName = String(usage.name || "").trim();
      const uplinkBytes = Number(usage.uplinkBytes);
      const downlinkBytes = Number(usage.downlinkBytes);
      if (
        !userName
        || userName.length > 320
        || !Number.isSafeInteger(uplinkBytes)
        || !Number.isSafeInteger(downlinkBytes)
        || uplinkBytes < 0
        || downlinkBytes < 0
      ) {
        throw domainError("INVALID_USAGE_COUNTER", "用户流量计数器无效");
      }
      return { userName, uplinkBytes, downlinkBytes };
    });
    const receivedAt = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO usage_samples (
          host_id, sample_id, runtime_instance_id, observed_at, received_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(hostId, sampleId, runtimeInstanceId, observedAt.toISOString(), receivedAt);
      this.db.prepare(`
        UPDATE hosts
        SET usage_last_sample_at = ?, usage_last_error = NULL,
            usage_last_error_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(receivedAt, receivedAt, hostId);
      if (Number(inserted.changes) === 0) {
        this.db.exec("COMMIT");
        return { applied: false, duplicate: true, appliedBytes: 0, quotaExceededUserIds: [] };
      }
      const usageSampleId = Number(inserted.lastInsertRowid);
      let appliedBytes = 0;
      const quotaExceededUserIds = [];
      for (const usage of normalized) {
        const user = this.db.prepare(`
          SELECT id, used_bytes, quota_gb
          FROM users
          WHERE email = ?
        `).get(usage.userName);
        if (!user) continue;
        const checkpoint = this.db.prepare(`
          SELECT runtime_instance_id, uplink_bytes, downlink_bytes
          FROM usage_counter_checkpoints
          WHERE host_id = ? AND user_name = ?
        `).get(hostId, usage.userName);
        const sameRuntime = checkpoint?.runtime_instance_id === runtimeInstanceId;
        const previousUplink = Number(checkpoint?.uplink_bytes || 0);
        const previousDownlink = Number(checkpoint?.downlink_bytes || 0);
        const uplinkDelta = sameRuntime
          ? Math.max(0, usage.uplinkBytes - previousUplink)
          : usage.uplinkBytes;
        const downlinkDelta = sameRuntime
          ? Math.max(0, usage.downlinkBytes - previousDownlink)
          : usage.downlinkBytes;
        const checkpointUplink = sameRuntime
          ? Math.max(previousUplink, usage.uplinkBytes)
          : usage.uplinkBytes;
        const checkpointDownlink = sameRuntime
          ? Math.max(previousDownlink, usage.downlinkBytes)
          : usage.downlinkBytes;
        this.db.prepare(`
          INSERT INTO usage_counter_checkpoints (
            host_id, user_name, runtime_instance_id, uplink_bytes, downlink_bytes, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(host_id, user_name) DO UPDATE SET
            runtime_instance_id = excluded.runtime_instance_id,
            uplink_bytes = excluded.uplink_bytes,
            downlink_bytes = excluded.downlink_bytes,
            updated_at = excluded.updated_at
        `).run(
          hostId,
          usage.userName,
          runtimeInstanceId,
          checkpointUplink,
          checkpointDownlink,
          receivedAt
        );
        const delta = uplinkDelta + downlinkDelta;
        if (delta === 0) continue;
        this.db.prepare(`
          INSERT INTO user_usage_ledger (
            sample_id, host_id, user_id, uplink_bytes, downlink_bytes, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          usageSampleId,
          hostId,
          user.id,
          uplinkDelta,
          downlinkDelta,
          observedAt.toISOString()
        );
        const beforeBytes = Number(user.used_bytes || 0);
        const afterBytes = beforeBytes + delta;
        if (!Number.isSafeInteger(afterBytes)) {
          throw domainError("USAGE_COUNTER_OVERFLOW", "用户累计流量超过安全计量范围");
        }
        this.db.prepare(`
          UPDATE users
          SET used_bytes = ?, used_gb = ?, updated_at = ?
          WHERE id = ?
        `).run(afterBytes, afterBytes / GIBIBYTE, receivedAt, user.id);
        const quotaBytes = Number(user.quota_gb) * GIBIBYTE;
        if (beforeBytes < quotaBytes && afterBytes >= quotaBytes) {
          quotaExceededUserIds.push(user.id);
        }
        appliedBytes += delta;
      }
      this.db.exec("COMMIT");
      return {
        applied: true,
        duplicate: false,
        appliedBytes,
        quotaExceededUserIds
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordUsageMeteringError(hostId, message) {
    const host = this.getHost(hostId);
    if (!host) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const timestamp = nowIso();
    const safeMessage = String(message || "未知计量错误")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 500);
    this.db.prepare(`
      UPDATE hosts
      SET usage_last_error = ?, usage_last_error_at = ?, updated_at = ?
      WHERE id = ?
    `).run(safeMessage, timestamp, timestamp, hostId);
    return this.getHost(hostId).usageMetering;
  }

  listClientHosts() {
    return this.db.prepare(`
      SELECT hosts.*
      FROM hosts
      WHERE hosts.id = 'local'
         OR EXISTS (
           SELECT 1 FROM node_tasks
           WHERE node_tasks.host_id = hosts.id
             AND node_tasks.kind = 'publish-config'
             AND node_tasks.status = 'succeeded'
         )
      ORDER BY hosts.created_at
    `).all().map(hostFromRow);
  }

  getHost(id) {
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id);
    return row ? hostFromRow(row) : null;
  }

  nodeEncryptionPublicKey(hostId) {
    return this.db.prepare(`
      SELECT encryption_public_key
      FROM hosts
      WHERE id = ? AND kind = 'remote'
    `).get(hostId)?.encryption_public_key || null;
  }

  createRemoteHost(input) {
    const host = normalizedHostInput(input);
    const id = randomUUID();
    const enrollmentToken = createSessionSecret();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO hosts (
        id, name, address, region, status, kind, enrollment_secret_hash,
        build_tags_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 'remote', ?, '[]', ?, ?)
    `).run(
      id,
      host.name,
      host.address,
      host.region,
      hashSessionSecret(enrollmentToken),
      timestamp,
      timestamp
    );
    return { host: this.getHost(id), enrollmentToken };
  }

  rotateNodeEnrollmentToken(hostId) {
    const host = this.getHost(hostId);
    if (!host || host.kind !== "remote") {
      throw domainError("HOST_NOT_FOUND", "远程主机不存在", 404);
    }
    if (host.enrolledAt) {
      throw domainError("NODE_ALREADY_ENROLLED", "节点已经注册，不能重新生成接入令牌", 409);
    }
    const enrollmentToken = createSessionSecret();
    this.db.prepare(`
      UPDATE hosts
      SET enrollment_secret_hash = ?, status = 'pending', updated_at = ?
      WHERE id = ?
    `).run(hashSessionSecret(enrollmentToken), nowIso(), hostId);
    return { host: this.getHost(hostId), enrollmentToken };
  }

  updateHost(id, input) {
    const current = this.getHost(id);
    if (!current) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const next = normalizedHostInput(input, current);
    this.db.prepare(`
      UPDATE hosts SET name = ?, address = ?, region = ?, updated_at = ? WHERE id = ?
    `).run(next.name, next.address, next.region, nowIso(), id);
    return this.getHost(id);
  }

  updateLocalRuntimeCapabilities(runtime = {}) {
    const buildTags = Array.isArray(runtime.tags)
      ? runtime.tags.map(String).filter((tag) => /^[a-zA-Z0-9_-]{1,64}$/.test(tag)).slice(0, 64)
      : [];
    this.db.prepare(`
      UPDATE hosts
      SET runtime_version = COALESCE(?, runtime_version),
          platform = COALESCE(?, platform),
          architecture = COALESCE(?, architecture),
          build_tags_json = ?,
          updated_at = ?
      WHERE id = 'local'
    `).run(
      runtime.version ? String(runtime.version).slice(0, 64) : null,
      runtime.platform ? String(runtime.platform).slice(0, 64) : null,
      runtime.architecture ? String(runtime.architecture).slice(0, 64) : null,
      JSON.stringify(buildTags),
      nowIso()
    );
    return this.getHost("local");
  }

  enrollNode(token, metadata = {}) {
    const row = this.db.prepare(`
      SELECT id FROM hosts
      WHERE kind = 'remote' AND enrollment_secret_hash = ?
    `).get(hashSessionSecret(String(token || "")));
    if (!row) throw domainError("NODE_ENROLLMENT_INVALID", "节点注册令牌无效或已经使用", 401);

    const nodeSecret = createSessionSecret();
    const timestamp = nowIso();
    const buildTags = Array.isArray(metadata.buildTags)
      ? metadata.buildTags.map(String).filter((tag) => /^[a-zA-Z0-9_-]{1,64}$/.test(tag)).slice(0, 64)
      : [];
    const encryptionPublicKey = String(metadata.encryptionPublicKey || "").slice(0, 4_096) || null;
    this.db.prepare(`
      UPDATE hosts
      SET enrollment_secret_hash = NULL, node_secret_hash = ?, status = 'online',
          hostname = ?, platform = ?, architecture = ?, agent_version = ?,
          runtime_version = ?, build_tags_json = ?, encryption_public_key = ?, last_seen_at = ?,
          enrolled_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      hashSessionSecret(nodeSecret),
      String(metadata.hostname || "").slice(0, 255) || null,
      String(metadata.platform || "").slice(0, 64) || null,
      String(metadata.architecture || "").slice(0, 64) || null,
      String(metadata.agentVersion || "").slice(0, 64) || null,
      String(metadata.runtimeVersion || "").slice(0, 64) || null,
      JSON.stringify(buildTags),
      encryptionPublicKey,
      timestamp,
      timestamp,
      timestamp,
      row.id
    );
    return { hostId: row.id, nodeSecret };
  }

  authenticateNode(hostId, secret) {
    if (!hostId || !secret) return null;
    const row = this.db.prepare(`
      SELECT id, agent_version AS agentVersion FROM hosts
      WHERE id = ? AND kind = 'remote' AND node_secret_hash = ?
    `).get(hostId, hashSessionSecret(secret));
    return row || null;
  }

  heartbeatNode(hostId, input = {}) {
    const current = this.getHost(hostId);
    if (!current || current.kind !== "remote") {
      throw domainError("NODE_NOT_FOUND", "节点不存在", 404);
    }
    const reportedRuntimeState = String(input.runtimeState || "");
    const reportedServiceStatus = normalizeTelemetry(input.telemetry).serviceStatus;
    const runtimeState = reportedRuntimeState === "running" || reportedServiceStatus === "running"
      ? "online"
      : ["staged", "stopped", "failed"].includes(reportedRuntimeState)
          || ["staged", "stopped", "failed"].includes(reportedServiceStatus)
        ? "degraded"
        : current.status === "degraded"
          ? "degraded"
          : "online";
    const timestamp = nowIso();
    const buildTags = Array.isArray(input.buildTags)
      ? input.buildTags.map(String).filter((tag) => /^[a-zA-Z0-9_-]{1,64}$/.test(tag)).slice(0, 64)
      : null;
    const encryptionPublicKey = input.encryptionPublicKey
      ? String(input.encryptionPublicKey).slice(0, 4_096)
      : null;
    this.db.prepare(`
      UPDATE hosts
      SET status = ?, runtime_version = COALESCE(?, runtime_version),
          agent_version = COALESCE(?, agent_version),
          build_tags_json = COALESCE(?, build_tags_json),
          encryption_public_key = COALESCE(?, encryption_public_key),
          last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      runtimeState,
      input.runtimeVersion ? String(input.runtimeVersion).slice(0, 64) : null,
      input.agentVersion ? String(input.agentVersion).slice(0, 64) : null,
      buildTags ? JSON.stringify(buildTags) : null,
      encryptionPublicKey,
      timestamp,
      timestamp,
      hostId
    );
    if (input.telemetry && typeof input.telemetry === "object") {
      this.recordHostTelemetry(hostId, input.telemetry, timestamp);
    }
    return this.getHost(hostId);
  }

  recordHostTelemetry(hostId, input = {}, timestamp = nowIso()) {
    const host = this.getHost(hostId);
    if (!host) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const telemetry = normalizeTelemetry(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE hosts
        SET cpu_percent = ?, memory_used_bytes = ?, memory_total_bytes = ?,
            network_rx_bytes = ?, network_tx_bytes = ?,
            network_rx_bps = ?, network_tx_bps = ?, service_status = ?,
            metrics_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        telemetry.cpuPercent,
        telemetry.memoryUsedBytes,
        telemetry.memoryTotalBytes,
        telemetry.networkRxBytes,
        telemetry.networkTxBytes,
        telemetry.networkRxBps,
        telemetry.networkTxBps,
        telemetry.serviceStatus,
        timestamp,
        timestamp,
        hostId
      );
      const latestSample = this.db.prepare(`
        SELECT id, recorded_at
        FROM host_metric_samples
        WHERE host_id = ?
        ORDER BY recorded_at DESC
        LIMIT 1
      `).get(hostId);
      const currentBucket = Math.floor(new Date(timestamp).getTime() / 300_000);
      const latestBucket = latestSample
        ? Math.floor(new Date(latestSample.recorded_at).getTime() / 300_000)
        : null;
      if (latestSample && currentBucket === latestBucket) {
        this.db.prepare(`
          UPDATE host_metric_samples
          SET cpu_percent = ?, memory_used_bytes = ?, memory_total_bytes = ?,
              network_rx_bytes = ?, network_tx_bytes = ?,
              network_rx_bps = ?, network_tx_bps = ?, service_status = ?,
              recorded_at = ?
          WHERE id = ?
        `).run(
          telemetry.cpuPercent,
          telemetry.memoryUsedBytes,
          telemetry.memoryTotalBytes,
          telemetry.networkRxBytes,
          telemetry.networkTxBytes,
          telemetry.networkRxBps,
          telemetry.networkTxBps,
          telemetry.serviceStatus,
          timestamp,
          latestSample.id
        );
      } else {
        this.db.prepare(`
          INSERT INTO host_metric_samples (
            host_id, cpu_percent, memory_used_bytes, memory_total_bytes,
            network_rx_bytes, network_tx_bytes, network_rx_bps, network_tx_bps,
            service_status, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          hostId,
          telemetry.cpuPercent,
          telemetry.memoryUsedBytes,
          telemetry.memoryTotalBytes,
          telemetry.networkRxBytes,
          telemetry.networkTxBytes,
          telemetry.networkRxBps,
          telemetry.networkTxBps,
          telemetry.serviceStatus,
          timestamp
        );
      }
      if (Date.now() - this.lastTelemetryPruneAt >= 60 * 60 * 1000) {
        this.db.prepare(`
          DELETE FROM host_metric_samples
          WHERE recorded_at < ?
        `).run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
        this.lastTelemetryPruneAt = Date.now();
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getHost(hostId).telemetry;
  }

  telemetryOverview(hours = 24) {
    const boundedHours = Math.min(168, Math.max(1, Number(hours) || 24));
    const since = new Date(Date.now() - boundedHours * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      WITH per_host AS (
        SELECT
          (unixepoch(recorded_at) / 300) * 300 AS bucket_epoch,
          host_id,
          AVG(COALESCE(network_rx_bps, 0)) AS download_bps,
          AVG(COALESCE(network_tx_bps, 0)) AS upload_bps
        FROM host_metric_samples
        WHERE recorded_at >= ?
        GROUP BY bucket_epoch, host_id
      )
      SELECT
        bucket_epoch,
        SUM(download_bps) AS download_bps,
        SUM(upload_bps) AS upload_bps
      FROM per_host
      GROUP BY bucket_epoch
      ORDER BY bucket_epoch
    `).all(since);
    return {
      windowHours: boundedHours,
      networkSeries: rows.map((row) => ({
        recordedAt: new Date(Number(row.bucket_epoch) * 1000).toISOString(),
        downloadBps: Number(row.download_bps || 0),
        uploadBps: Number(row.upload_bps || 0)
      }))
    };
  }

  queueNodeTask(hostId, kind, payload, options = {}) {
    const host = this.getHost(hostId);
    if (!host || host.kind !== "remote" || !host.enrolledAt) {
      throw domainError("NODE_NOT_ENROLLED", "远程节点尚未完成注册", 409);
    }
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let priority = options.priority === "critical"
        ? 100
        : Math.max(0, Number(options.priority) || 0);
      let maxAttempts = options.maxAttempts === 0
        ? 0
        : Math.max(1, Number(options.maxAttempts) || 5);
      if (kind === "publish-config") {
        const superseded = this.db.prepare(`
          SELECT MAX(priority) AS priority,
                 MIN(CASE WHEN max_attempts = 0 THEN 0 ELSE max_attempts END) AS max_attempts
          FROM node_tasks
          WHERE host_id = ? AND kind = 'publish-config' AND status = 'pending'
        `).get(hostId);
        priority = Math.max(priority, Number(superseded?.priority || 0));
        if (Number(superseded?.max_attempts) === 0 && Number(superseded?.priority) >= 100) {
          maxAttempts = 0;
        }
        this.db.prepare(`
          DELETE FROM node_tasks
          WHERE host_id = ? AND kind = 'publish-config' AND status = 'pending'
        `).run(hostId);
      } else if (kind === "upgrade-runtime") {
        this.db.prepare(`
          DELETE FROM node_tasks
          WHERE host_id = ? AND kind = 'upgrade-runtime' AND status = 'pending'
        `).run(hostId);
      }
      this.db.prepare(`
        INSERT INTO node_tasks (
          id, host_id, kind, payload_json, status, priority, max_attempts, created_at
        )
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(id, hostId, kind, JSON.stringify(payload), priority, maxAttempts, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return id;
  }

  latestAppliedNodeConfig(hostId) {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM node_tasks
      WHERE host_id = ? AND kind = 'publish-config' AND status = 'succeeded'
      ORDER BY finished_at DESC
      LIMIT 1
    `).get(hostId);
    const payload = parseJson(row?.payload_json, {});
    if (!payload.configText) return null;
    return parseJson(payload.configText, null);
  }

  nextNodeTask(hostId) {
    const now = nowIso();
    const retryBefore = new Date(Date.now() - 60_000).toISOString();
    const task = this.db.prepare(`
      SELECT id, kind, payload_json, priority, attempt_count
      FROM node_tasks
      WHERE host_id = ?
        AND (
          (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'claimed' AND claimed_at < ?)
        )
      ORDER BY priority DESC, created_at DESC
      LIMIT 1
    `).get(hostId, now, retryBefore);
    if (!task) return null;
    this.db.prepare(`
      UPDATE node_tasks
      SET status = 'claimed', claimed_at = ?, attempt_count = attempt_count + 1
      WHERE id = ?
    `).run(now, task.id);
    return {
      id: task.id,
      kind: task.kind,
      payload: parseJson(task.payload_json, {}),
      priority: Number(task.priority) >= 100 ? "critical" : "normal",
      attempt: Number(task.attempt_count) + 1
    };
  }

  completeNodeTask(hostId, taskId, input = {}) {
    const task = this.db.prepare(`
      SELECT id, kind, status, attempt_count, max_attempts
      FROM node_tasks
      WHERE id = ? AND host_id = ?
    `).get(taskId, hostId);
    if (!task) throw domainError("NODE_TASK_NOT_FOUND", "节点任务不存在", 404);
    const attempt = Number(input.attempt);
    if (
      task.status !== "claimed"
      || !Number.isInteger(attempt)
      || attempt !== Number(task.attempt_count)
    ) {
      return { id: taskId, status: task.status, ignored: true };
    }
    const succeeded = input.status === "succeeded";
    const retryable = !succeeded
      && task.kind === "publish-config"
      && (Number(task.max_attempts) === 0 || Number(task.attempt_count) < Number(task.max_attempts));
    const status = succeeded ? "succeeded" : retryable ? "pending" : "failed";
    const timestamp = nowIso();
    const retryDelayMs = this.nodeTaskRetryBaseMs * Math.min(
      16,
      2 ** Math.max(0, Number(task.attempt_count) - 1)
    );
    const retryAt = retryable
      ? new Date(Date.now() + retryDelayMs).toISOString()
      : null;
    this.db.prepare(`
      UPDATE node_tasks
      SET status = ?, result_json = ?, finished_at = ?,
          claimed_at = ?, next_attempt_at = ?
      WHERE id = ? AND host_id = ? AND status = 'claimed' AND attempt_count = ?
    `).run(
      status,
      JSON.stringify(input),
      retryable ? null : timestamp,
      retryable ? null : timestamp,
      retryAt,
      taskId,
      hostId,
      attempt
    );
    this.db.prepare(`
      UPDATE hosts
      SET status = ?, runtime_version = COALESCE(?, runtime_version),
          last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      succeeded ? "online" : "degraded",
      input.result?.runtimeVersion
        ? String(input.result.runtimeVersion).slice(0, 64)
        : input.runtimeVersion
          ? String(input.runtimeVersion).slice(0, 64)
          : null,
      timestamp,
      timestamp,
      hostId
    );
    return {
      id: taskId,
      status,
      ...(retryAt ? { retryAt } : {})
    };
  }

  bootstrap(admin) {
    return {
      currentAdmin: { id: admin.id, username: admin.username },
      users: this.listUsers(),
      hosts: this.listHosts()
    };
  }

  createUser(input) {
    const name = String(input.name || "").trim();
    const email = String(input.email || "").trim().toLowerCase();
    const entitlement = {
      quotaGb: Number(input.quotaGb),
      nodeScope: input.nodeScope,
      clientFormats: input.clientFormats
    };
    if (!name) throw domainError("INVALID_USER_NAME", "用户名称不能为空");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw domainError("INVALID_EMAIL", "邮箱地址格式不正确");
    }
    validateUserEntitlement(entitlement);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.expiresAt || ""))) {
      throw domainError("INVALID_EXPIRY", "到期时间格式必须为 YYYY-MM-DD");
    }
    const portalStatus = input.portalStatus === undefined ? "invited" : String(input.portalStatus);
    if (!["active", "invited"].includes(portalStatus)) {
      throw domainError("INVALID_PORTAL_STATUS", "用户中心状态不正确");
    }
    const state = input.state === undefined ? "active" : String(input.state);
    if (!["active", "warning", "disabled"].includes(state)) {
      throw domainError("INVALID_USER_STATE", "用户状态不正确");
    }
    const usedGb = input.usedGb === undefined ? 0 : Number(input.usedGb);
    if (!Number.isFinite(usedGb) || usedGb < 0) {
      throw domainError("INVALID_USAGE", "已用流量必须是大于或等于 0 的数值");
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
          id, name, initials, email, password_hash, portal_status, state, used_gb, used_bytes,
          plan_id, quota_gb, device_limit, node_scope_json, client_formats_json,
          expires_at, runtime_uuid, runtime_password, subscription_public_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        name,
        initials,
        email,
        hashPassword(input.password || createRuntimePassword(12)),
        portalStatus,
        state,
        usedGb,
        Math.round(usedGb * GIBIBYTE),
        LEGACY_ENTITLEMENT_PLAN_ID,
        entitlement.quotaGb,
        1,
        JSON.stringify(entitlement.nodeScope),
        JSON.stringify(entitlement.clientFormats),
        input.expiresAt,
        randomUUID(),
        createShadowsocksKey(),
        createRuntimePassword(18),
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
      SELECT id, name, initials, email, portal_status, state, used_gb, used_bytes, quota_gb,
             node_scope_json, client_formats_json, expires_at,
             subscription_public_id, subscription_secret_hash
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
      quotaGb: input.quotaGb === undefined ? current.quotaGb : Number(input.quotaGb),
      nodeScope: input.nodeScope === undefined ? current.nodeScope : input.nodeScope,
      clientFormats: input.clientFormats === undefined ? current.clientFormats : input.clientFormats,
      expiresAt: input.expiresAt === undefined ? current.expiresAt : String(input.expiresAt),
      state: input.state === undefined ? current.state : String(input.state),
      portalStatus: input.portalStatus === undefined ? current.portalStatus : String(input.portalStatus),
      usedGb: input.usedGb === undefined ? current.usedGb : Number(input.usedGb)
    };
    if (!next.name) throw domainError("INVALID_USER_NAME", "用户名称不能为空");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
      throw domainError("INVALID_EMAIL", "邮箱地址格式不正确");
    }
    validateUserEntitlement(next);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.expiresAt)) {
      throw domainError("INVALID_EXPIRY", "到期时间格式必须为 YYYY-MM-DD");
    }
    if (!["active", "warning", "disabled"].includes(next.state)) {
      throw domainError("INVALID_USER_STATE", "用户状态不正确");
    }
    if (!["active", "invited"].includes(next.portalStatus)) {
      throw domainError("INVALID_PORTAL_STATUS", "用户中心状态不正确");
    }
    if (!Number.isFinite(next.usedGb) || next.usedGb < 0) {
      throw domainError("INVALID_USAGE", "已用流量必须是大于或等于 0 的数值");
    }
    if (input.password !== undefined && String(input.password).length < 8) {
      throw domainError("INVALID_PASSWORD", "用户中心密码至少需要 8 位");
    }
    const initials = next.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || current.initials;
    try {
      this.db.prepare(`
        UPDATE users
        SET name = ?, initials = ?, email = ?, quota_gb = ?,
            node_scope_json = ?, client_formats_json = ?, expires_at = ?,
            state = ?, portal_status = ?, used_gb = ?, used_bytes = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.name,
        initials,
        next.email,
        next.quotaGb,
        JSON.stringify(next.nodeScope),
        JSON.stringify(next.clientFormats),
        next.expiresAt,
        next.state,
        next.portalStatus,
        next.usedGb,
        Math.round(next.usedGb * GIBIBYTE),
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

  runtimeSnapshot(hostId = "local") {
    const host = this.db.prepare(`
      SELECT id, name, address, region, status, build_tags_json
      FROM hosts
      WHERE id = ?
    `).get(hostId);
    if (!host) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    host.buildTags = parseJson(host.build_tags_json, []);
    delete host.build_tags_json;
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'shadowsocks_master_password'").get();
    const users = this.db.prepare(`
      SELECT users.email, users.state, users.portal_status, users.used_gb, users.expires_at,
             users.runtime_uuid, users.runtime_password, users.quota_gb, users.node_scope_json
      FROM users
      ORDER BY users.email
    `).all().map((row) => ({
      email: row.email,
      state: row.state,
      portalStatus: row.portal_status,
      usedGb: row.used_gb,
      quotaGb: row.quota_gb,
      expiresAt: row.expires_at,
      runtimeUuid: row.runtime_uuid,
      runtimePassword: row.runtime_password,
      nodeScope: parseJson(row.node_scope_json, [])
    }));
    return {
      host,
      masterPassword: setting.value,
      users,
      protocols: this.listProtocolConfigs()
    };
  }

  listProtocolConfigs() {
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'runtime_protocols'").get();
    return normalizeProtocolConfigs(parseJson(setting?.value, []));
  }

  updateProtocolConfig(type, input) {
    const profiles = this.listProtocolConfigs();
    const index = profiles.findIndex((profile) => profile.type === type);
    if (index < 0) throw domainError("PROTOCOL_NOT_FOUND", "sing-box 入站协议不存在", 404);
    const current = profiles[index];
    const next = normalizeProtocolConfig({
      ...current,
      ...input,
      type,
      tls: { ...current.tls, ...(input.tls || {}) },
      transport: { ...current.transport, ...(input.transport || {}) },
      options: input.options === undefined ? current.options : input.options
    });
    const candidate = profiles.toSpliced(index, 1, next);
    assertProtocolSet(candidate);
    this.db.prepare(`
      UPDATE settings SET value = ?, updated_at = ? WHERE key = 'runtime_protocols'
    `).run(JSON.stringify(candidate), nowIso());
    return next;
  }

  createDeployment({ version, configJson, checksum, eligibleUsers, publisherAdminId = null }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO deployments (
        id, version, status, config_json, error_json, publisher_admin_id, created_at, published_at
      ) VALUES (?, ?, 'validating', ?, NULL, ?, ?, NULL)
    `).run(
      id,
      version,
      JSON.stringify({ config: configJson, checksum, eligibleUsers }),
      publisherAdminId,
      nowIso()
    );
    return id;
  }

  finishDeployment(id, { status, error = null }) {
    if (status === "active") {
      this.db.prepare(`
        UPDATE deployments SET status = 'superseded' WHERE status = 'active' AND id <> ?
      `).run(id);
    }
    this.db.prepare(`
      UPDATE deployments
      SET status = ?, error_json = ?, published_at = ?
      WHERE id = ?
    `).run(status, error ? JSON.stringify({ message: error }) : null, status === "active" ? nowIso() : null, id);
  }

  listDeployments(limit = 20) {
    return this.db.prepare(`
      SELECT deployments.id, deployments.version, deployments.status, deployments.config_json,
             deployments.error_json, deployments.created_at, deployments.published_at,
             admins.username AS publisher_username
      FROM deployments
      LEFT JOIN admins ON admins.id = deployments.publisher_admin_id
      ORDER BY deployments.created_at DESC
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
        publisherUsername: row.publisher_username || null,
        createdAt: row.created_at,
        publishedAt: row.published_at
      };
    });
  }

  deploymentSnapshot(id) {
    const row = this.db.prepare(`
      SELECT id, version, status, config_json FROM deployments WHERE id = ?
    `).get(id);
    if (!row) throw domainError("DEPLOYMENT_NOT_FOUND", "部署记录不存在", 404);
    const metadata = parseJson(row.config_json, {});
    if (!metadata.config) throw domainError("DEPLOYMENT_SNAPSHOT_MISSING", "部署快照不可用", 409);
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      config: metadata.config,
      checksum: metadata.checksum,
      eligibleUsers: metadata.eligibleUsers
    };
  }

  close() {
    this.db.close();
  }
}
