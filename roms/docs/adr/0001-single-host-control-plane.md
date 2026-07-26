# Start with a single-host control plane and a replaceable runtime adapter

RayLink will ship first as one Node.js process backed by SQLite, serving the web application and publishing configuration to a local sing-box runtime through a small adapter. This keeps deployment and backup simple for the initial single-server use case, while the adapter seam allows a future remote Host service without changing User Entitlement or Deployment semantics.

The remote Host part of this decision is implemented and refined by [ADR 0003](0003-remote-hosts-use-raylink-node.md).
