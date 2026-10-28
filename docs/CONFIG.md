# Configuration

The service reads `CONTEXT_CONFIG_PATH` (default `config/context.config.yaml`) at start-up and refuses to start when the file is invalid; the error names the file and every offending key.

| Key | Meaning |
|-----|---------|
| `version` | Config version, copied into every packet as `configVersion`. |
| `identity.mode` | `act_as_assertion` or `firebase_passthrough`. |
| `sources.<kind>` | One entry per section kind (`policy`, `task`, `conversation`, `memory`, `audit_history`, `analytics`, `tools`): `enabled`, `timeoutMs` (a source that does not answer in time becomes a `source_timeout` gap), `tokenShare` (enabled shares add up to at most 1; a section other than policy, task and tools may use at most this share of the budget). |
| `cache` | `enabled` (default `false`), `ttlSeconds` (default `0`, must be positive when enabled), `maxEntries`. |
| `budget` | `defaultTokens`, `maxTokens` (a request's `budgetTokens` is capped by it), and `priorities` per section kind (lower is kept first). Policy, task and tools are never dropped whatever their priority; the others are trimmed in reverse priority order. |
| `allowedDownstreamHosts` | Hosts (`host` or `host:port`) the service may call. The host of `REDIS_URL` must be listed (`redis:6379` in the shipped file). |
| `limits` | `maxNeedsPerRequest`, `maxItemsPerSource`, `maxItemChars`, `maxRequestBytes`. |
| `redaction.pii` | Default `true`. Redact email, phone, card, IBAN and SSN as well as secrets. Secrets are always redacted. |

Unknown keys are rejected. The config file's directory also holds everything else the service reads: `templates/`, `policy.yaml` and `tools.yaml`.

## Templates

`templates/<stepType>.v<N>.yaml`, one or more versions per step type, validated by the template schema. The service uses the highest `N` per step type and refuses a file whose name disagrees with its `stepType`. `sections` lists section kinds (once each) with `required` and an optional `maxItems`. A section the config switches off (`sources.<kind>.enabled: false`) is skipped; if it is `policy` or `task` and the template requires it, builds for that step fail. `templateVersion` is copied into every packet.

## Policy: `policy.yaml`

| Key | Meaning |
|-----|---------|
| `statements[]` | `id`, `text`, `appliesTo` (step types). Served as the `policy` section (system trust). |
| `restrictedTools[]` | `name`, `appliesTo`, `reason`. A tool listed here is never described to the brain in those steps, even if `tools.yaml` lists it for the step. Enforced in the tool catalog adapter and again in the pipeline. |
| `restrictedNeeds[]` | `kind` (`memory_search`, `analytics_compare`, `audit_trace`, `conversation_before`), `appliesTo`, `reason`. A need of that kind in those steps is refused with a `need_refused_by_policy` gap, and `GET /v1/context/needs` leaves it out. Both lists default to empty. |

## Tools: `tools.yaml`

`tools[]` with `name` (snake_case), `description`, `risk` (`low`, `medium`, `high`) and `appliesTo`. Served as the `tools` section: `text` is the description, `data` is `{ name, risk }`.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3500` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address inside the container; Compose publishes it on `127.0.0.1` only. |
| `LOG_LEVEL` | `info` | Log level. |
| `CONTEXT_CONFIG_PATH` | `config/context.config.yaml` | Config file. Templates, policy and tools are read from its directory. |
| `NODE_ENV` | unset | `production` (the container default) refuses local identities and requires `REDIS_URL`. |
| `REDIS_URL` | none | Redis that holds the audit stream, for example `redis://:password@redis:6379`. Its host must be in `allowedDownstreamHosts`. Required when `NODE_ENV=production`; without it, outside production, audit events are printed one line each. |
| `AUDIT_STREAM` | `proba.audit.events` | Stream name (the one the audit consumer reads). |
| `AUDIT_STREAM_MAXLEN` | `0` (no trimming) | Approximate `MAXLEN` for the stream. |
| `AUDIT_API_TOKEN`, `MEMORY_API_TOKEN` | none, required by Compose | Credentials for the downstream services. |
| `REDIS_PASSWORD` | none, required by Compose | Password of the Compose Redis, also used in `REDIS_URL`. |
