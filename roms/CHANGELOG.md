# RayLink Changelog

## 0.2.17 - 2026-07-30

### Added

- Unified routing policy exported consistently to sing-box, Mihomo and Egern.
- Deployment Target status and atomic remote task claiming for multi-Host rollout.
- Owner, Operator, Support and Auditor roles with mutation audit events.
- Online SQLite backup, verified restore tooling and pre-upgrade migration checks.
- Protocol health windows using P50, P95, MAD jitter and TCP/UDP stability admission.
- Webhook alerts for Host, Deployment, protocol, metering, memory, disk, certificate and backup health.
- Native Linux AMD64 and ARM64 release pipelines with SHA-256 manifests, SPDX SBOMs and GitHub build provenance.

### Changed

- RayLink Node telemetry now reports disk capacity in addition to CPU, memory, network and Runtime state.
- Official one-command installation accepts both Linux AMD64 and ARM64 release packages.
