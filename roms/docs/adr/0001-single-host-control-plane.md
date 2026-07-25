# Start with a single-host control plane and a replaceable runtime adapter

RayLink will ship first as one Node.js process backed by SQLite, serving the web application and publishing configuration to a local sing-box runtime through a small adapter. This keeps deployment and backup simple for the current single-server use case, while the adapter seam allows a future remote Host agent without changing User, Plan, or Deployment semantics.
