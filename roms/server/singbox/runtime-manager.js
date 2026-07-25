import { createHash, randomUUID } from "node:crypto";

import { buildSingBoxConfig } from "./config.js";

function deploymentVersion(now = new Date()) {
  return `v${now.toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
}

function compile(store, listenPort) {
  const config = buildSingBoxConfig(store.runtimeSnapshot(), { listenPort });
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const checksum = createHash("sha256").update(configText).digest("hex");
  return {
    config,
    configText,
    checksum,
    eligibleUsers: config.inbounds.reduce((sum, inbound) => sum + (inbound.users?.length || 0), 0)
  };
}

export class RuntimeManager {
  constructor({ store, adapter, listenPort = 8388 }) {
    this.store = store;
    this.adapter = adapter;
    this.listenPort = listenPort;
  }

  preview() {
    const compiled = compile(this.store, this.listenPort);
    return {
      checksum: compiled.checksum,
      eligibleUsers: compiled.eligibleUsers,
      inboundCount: compiled.config.inbounds.length,
      listenPort: this.listenPort
    };
  }

  async publish() {
    const compiled = compile(this.store, this.listenPort);
    const version = deploymentVersion();
    const deploymentId = this.store.createDeployment({
      version,
      configJson: compiled.config,
      checksum: compiled.checksum,
      eligibleUsers: compiled.eligibleUsers
    });

    try {
      const runtime = await this.adapter.publish({
        version,
        checksum: compiled.checksum,
        configText: compiled.configText
      });
      this.store.finishDeployment(deploymentId, { status: "active" });
      return {
        ...this.store.listDeployments().find((deployment) => deployment.id === deploymentId),
        runtime
      };
    } catch (error) {
      this.store.finishDeployment(deploymentId, { status: "failed", error: error.message });
      throw error;
    }
  }

  async status() {
    return this.adapter.status();
  }
}
