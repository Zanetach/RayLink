# RayLink Changelog

## 0.2.20 - 2026-08-02

### Changed

- Subscription delivery now uses a compact two-column client picker in both
  the administrator drawer and user portal.
- Clash/Mihomo is presented as the recommended import while Egern full-profile
  and node-only imports remain clearly separated.

## 0.2.19 - 2026-08-01

### Fixed

- Online SQLite backups now remove temporary WAL and shared-memory sidecars
  after successful creation.
- The next backup automatically cleans temporary SQLite files left by an
  interrupted previous backup, preventing unbounded backup-directory growth.

## 0.2.18 - 2026-08-01

### Fixed

- Release verification now respects root-owned protocol Runtime artifacts and
  verifies the pinned Cronet companion checksum before protocol acceptance.
- Memory soak checks use a bounded keep-alive client pool, separating server
  memory behavior from Node.js client socket allocation high-water marks.

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
- Approved Linux Runtime packages now include the pinned Cronet companion required for real Naive protocol probes, including checksums, rollback and SBOM metadata.
