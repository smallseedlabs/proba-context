# Configuration

The service reads `CONTEXT_CONFIG_PATH` (default `config/context.config.yaml`) at start-up and refuses to start when the file is invalid; the error names the file and every offending key.

| Key | Meaning |
|-----|---------|
| `version` | Config version, copied into every packet as `configVersion`. |
| `identity.mode` | `act_as_assertion` or `firebase_passthrough`. |
| `sources.<kind>` | One entry per section kind (`policy`, `task`, `conversation`, `memory`, `audit_history`, `analytics`, `tools`): `enabled`, `timeoutMs`, `tokenShare` (enabled shares add up to at most 1). |
| `cache` | `enabled` (default `false`), `ttlSeconds` (default `0`, must be positive when enabled), `maxEntries`. |
| `budget` | `defaultTokens`, `maxTokens`, and `priorities` per section kind (lower is kept first). |
| `allowedDownstreamHosts` | Hosts (`host` or `host:port`) the service may call. |
| `limits` | `maxNeedsPerRequest`, `maxItemsPerSource`, `maxItemChars`, `maxRequestBytes`. |

Unknown keys are rejected. Templates live in `config/templates/<stepType>.v<N>.yaml`, one per step type, validated by the template schema. `config/policy.yaml` and `config/tools.yaml` hold the policy statements and the tool descriptions.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3500` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address inside the container; Compose publishes it on `127.0.0.1` only. |
| `LOG_LEVEL` | `info` | Log level. |
| `CONTEXT_CONFIG_PATH` | `config/context.config.yaml` | Config file. |
| `AUDIT_API_TOKEN`, `MEMORY_API_TOKEN` | none, required by Compose | Credentials for the downstream services. |
