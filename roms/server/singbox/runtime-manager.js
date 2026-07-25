import { createHash, randomUUID } from "node:crypto";

import { buildSingBoxConfig } from "./config.js";

function deploymentVersion(prefix = "v", now = new Date()) {
  return `${prefix}${now.toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
}

function compile(store, listenPort) {
  const config = buildSingBoxConfig(store.runtimeSnapshot(), { listenPort });
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const checksum = createHash("sha256").update(configText).digest("hex");
  const eligibleUsers = new Set(
    config.inbounds.flatMap((inbound) => inbound.users?.map((user) => user.name || user.username) || [])
  ).size;
  return {
    config,
    configText,
    checksum,
    eligibleUsers
  };
}

export class RuntimeManager {
  constructor({ store, adapter, listenPort = 8388 }) {
    this.store = store;
    this.adapter = adapter;
    this.listenPort = listenPort;
    this.publishing = false;
  }

  preview() {
    const compiled = compile(this.store, this.listenPort);
    return {
      checksum: compiled.checksum,
      eligibleUsers: compiled.eligibleUsers,
      inboundCount: compiled.config.inbounds.length,
      listenPort: compiled.config.inbounds[0]?.listen_port || null,
      protocols: compiled.config.inbounds.map((inbound) => inbound.type)
    };
  }

  async publish(publisherAdminId = null) {
    const compiled = compile(this.store, this.listenPort);
    return this.publishCompiled({
      ...compiled,
      version: deploymentVersion(),
      publisherAdminId
    });
  }

  async rollback(sourceDeploymentId, publisherAdminId = null) {
    const snapshot = this.store.deploymentSnapshot(sourceDeploymentId);
    const configText = `${JSON.stringify(snapshot.config, null, 2)}\n`;
    return this.publishCompiled({
      config: snapshot.config,
      configText,
      checksum: createHash("sha256").update(configText).digest("hex"),
      eligibleUsers: snapshot.eligibleUsers,
      version: deploymentVersion("r"),
      publisherAdminId
    });
  }

  async publishCompiled({ config, configText, checksum, eligibleUsers, version, publisherAdminId }) {
    if (this.publishing) {
      const error = new Error("已有配置正在发布，请稍后重试");
      error.code = "DEPLOYMENT_IN_PROGRESS";
      error.statusCode = 409;
      throw error;
    }
    this.publishing = true;
    let deploymentId;
    try {
      deploymentId = this.store.createDeployment({
        version,
        configJson: config,
        checksum,
        eligibleUsers,
        publisherAdminId
      });
      const runtime = await this.adapter.publish({
        version,
        checksum,
        configText
      });
      this.store.finishDeployment(deploymentId, { status: "active" });
      return {
        ...this.store.listDeployments().find((deployment) => deployment.id === deploymentId),
        runtime
      };
    } catch (error) {
      if (deploymentId) this.store.finishDeployment(deploymentId, { status: "failed", error: error.message });
      throw error;
    } finally {
      this.publishing = false;
    }
  }

  async status() {
    return this.adapter.status();
  }
}
