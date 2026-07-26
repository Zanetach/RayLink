# Remote Hosts use a pull-based RayLink Node

RayLink supports additional Linux Hosts through a small RayLink Node installed beside sing-box.

The administrator creates a Host in the control plane and receives a one-time enrollment token. The remote Host uses that token once to exchange its machine metadata for a long-lived node credential. Only a hash of each secret is stored by the control plane.

RayLink Node initiates all control traffic over HTTP(S): it sends heartbeats, polls for Host-scoped tasks, validates a received configuration with `sing-box check`, atomically replaces the active file, restarts the managed systemd unit, and reports success or failure. The control plane does not require SSH credentials and does not open an inbound management port on the remote Host.

Deployments compile a separate configuration for each Host so User Entitlement node scope is enforced before credentials reach that Host. User Center configurations contain every connected Host allowed by the User's node scope.

The first implementation queues a publication for every enrolled remote Host at once. Batched rollout, maintenance windows, remote historical rollback, certificate distribution, and traffic telemetry remain separate decisions.
