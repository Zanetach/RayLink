# Remote Hosts use a pull-based RayLink Node

RayLink supports additional Linux Hosts through a small RayLink Node installed beside sing-box.

The administrator creates a Host in the control plane and receives a one-time enrollment token. The remote Host uses that token once to exchange its machine metadata for a long-lived node credential. Only a hash of each secret is stored by the control plane.

RayLink Node initiates all control traffic over HTTP(S): it sends heartbeats, polls for Host-scoped tasks, validates a received configuration with `sing-box check`, atomically replaces the active file, restarts the managed systemd unit, and reports success or failure. The control plane does not require SSH credentials and does not open an inbound management port on the remote Host.

Deployments compile a separate configuration for each Host so User Entitlement node scope is enforced before credentials reach that Host. User Center configurations contain every connected Host allowed by the User's node scope.

The first implementation queues a publication for every enrolled remote Host at once. User Entitlement
revocation publications have critical priority, supersede older pending configuration tasks, and retry with
persistent exponential backoff until the Host confirms success. The control plane exposes the pending state;
an offline Host cannot be made safe instantaneously, but it applies the latest revocation before normal queued work
as soon as RayLink Node reconnects.

RayLink Node 0.4 also accepts an explicit `upgrade-runtime` task. It backs up the currently resolved
sing-box binary, installs only a control-plane-approved stable version, checks the existing active
configuration with the candidate binary, disables a conflicting package-managed systemd unit, restarts
the RayLink-managed Runtime, and verifies that the service remains active across a bounded health window and
still reports the expected version. A failed validation or restart restores the previous package version,
exact binary, and prior systemd service state before reporting task failure. The control plane keeps the latest
upgrade target, terminal state, rollback result and error visible on the Host. Reinstalling RayLink Node preserves an already
installed compatible 1.13.x Runtime instead of downgrading it.

Runtime upgrades are administrator-triggered and are not entitlement-critical tasks. Batched rollout,
maintenance windows, certificate distribution, and traffic telemetry remain separate decisions.
