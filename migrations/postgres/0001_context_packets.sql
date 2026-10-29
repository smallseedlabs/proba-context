-- Packet manifests only (no section payloads). Used by admin GET /v1/context/packets*.
CREATE TABLE IF NOT EXISTS context_packets (
  packet_id         UUID PRIMARY KEY,
  packet_hash       TEXT        NOT NULL,
  workspace_id      TEXT        NOT NULL,
  user_id           TEXT        NOT NULL,
  goal_id           TEXT        NOT NULL,
  step_id           TEXT        NOT NULL,
  step_type         TEXT        NOT NULL,
  config_version    TEXT        NOT NULL,
  template_version  TEXT        NOT NULL,
  manifest          JSONB       NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_packets_goal_created_idx
  ON context_packets (goal_id, created_at DESC, packet_id DESC);

CREATE INDEX IF NOT EXISTS context_packets_workspace_created_idx
  ON context_packets (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS context_packets_created_at_idx
  ON context_packets (created_at);
