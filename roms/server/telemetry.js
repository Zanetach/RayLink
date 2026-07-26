import { readFile } from "node:fs/promises";
import { cpus, freemem, platform, totalmem } from "node:os";

function cpuTimesSnapshot() {
  return cpus().reduce((totals, cpu) => {
    totals.idle += cpu.times.idle;
    totals.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return totals;
  }, { idle: 0, total: 0 });
}

async function networkBytesSnapshot() {
  if (platform() !== "linux") return { networkRxBytes: null, networkTxBytes: null };
  try {
    const content = await readFile("/proc/net/dev", "utf8");
    return content.split("\n").slice(2).reduce((totals, line) => {
      const [interfaceName, counters] = line.trim().split(/\s*:\s*/);
      if (!interfaceName || !counters || interfaceName === "lo") return totals;
      const fields = counters.trim().split(/\s+/).map(Number);
      totals.networkRxBytes += Number.isFinite(fields[0]) ? fields[0] : 0;
      totals.networkTxBytes += Number.isFinite(fields[8]) ? fields[8] : 0;
      return totals;
    }, { networkRxBytes: 0, networkTxBytes: 0 });
  } catch {
    return { networkRxBytes: null, networkTxBytes: null };
  }
}

export class LocalTelemetryCollector {
  constructor(options = {}) {
    this.clock = options.clock || Date.now;
    this.previous = null;
  }

  async collect(runtime = {}) {
    const memoryTotalBytes = totalmem();
    const sample = {
      cpu: cpuTimesSnapshot(),
      memoryUsedBytes: memoryTotalBytes - freemem(),
      memoryTotalBytes,
      ...await networkBytesSnapshot()
    };
    const timestamp = this.clock();
    const elapsedSeconds = this.previous
      ? Math.max(0.001, (timestamp - this.previous.timestamp) / 1000)
      : null;
    const totalDelta = this.previous ? sample.cpu.total - this.previous.sample.cpu.total : 0;
    const idleDelta = this.previous ? sample.cpu.idle - this.previous.sample.cpu.idle : 0;
    const cpuPercent = totalDelta > 0
      ? ((totalDelta - idleDelta) / totalDelta) * 100
      : 0;
    const byteRate = (current, previous) => {
      if (
        elapsedSeconds === null
        || !Number.isFinite(current)
        || !Number.isFinite(previous)
        || current < previous
      ) return 0;
      return ((current - previous) * 8) / elapsedSeconds;
    };
    const telemetry = {
      cpuPercent: Number(Math.max(0, Math.min(100, cpuPercent)).toFixed(1)),
      memoryUsedBytes: sample.memoryUsedBytes,
      memoryTotalBytes: sample.memoryTotalBytes,
      networkRxBytes: sample.networkRxBytes,
      networkTxBytes: sample.networkTxBytes,
      networkRxBps: byteRate(sample.networkRxBytes, this.previous?.sample.networkRxBytes),
      networkTxBps: byteRate(sample.networkTxBytes, this.previous?.sample.networkTxBytes),
      serviceStatus: runtime.state === "running"
        ? "running"
        : runtime.state === "staged"
          ? "staged"
        : runtime.state === "stopped"
          ? "stopped"
          : "unknown"
    };
    this.previous = { sample, timestamp };
    return telemetry;
  }
}
