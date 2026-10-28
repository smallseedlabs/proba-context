# Security policy

## Supported versions

proba-context is pre-1.0 and has no long-lived release branches. Security fixes land on `main` and in the next release; only the latest release and `main` are supported.

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a security problem.

Report it privately with GitHub private vulnerability reporting: open the repository's **Security** tab, choose **Report a vulnerability**,
and describe the problem. Include what is affected (component and version or commit), the steps to reproduce it, and the impact you expect.
Please do not include real credentials or personal data in the report.

You can expect an acknowledgement of the report, an assessment, and a fix or a mitigation plan. Once a fix is released the report may be
published as a security advisory, crediting the reporter if they wish.

## Handling secrets

This repository must never contain secrets: API keys, tokens, passwords or private keys. If you find one committed, report it as above so that it can be revoked and removed.
CI scans every push and pull request with the gitleaks CLI (`.gitleaks.toml`; test files are allow-listed for intentionally fake values).

## Hardening notes for operators

- **Local stack is loopback only, with no default passwords.** `docker-compose.yml` binds every published port to `127.0.0.1` and refuses to start until every credential is set
  (`AUDIT_API_TOKEN`, `MEMORY_API_TOKEN`). CI fails if a port loses the loopback bind or a credential gains a default. To reach the service from another machine, put a TLS reverse proxy in front; do not widen the bind.
- **Least privilege container.** The image runs as a non-root user with a read-only root filesystem, all capabilities dropped and `no-new-privileges`.
- **Pinned supply chain.** The base image is pinned by digest, GitHub Actions are pinned by commit SHA, and `@smallseedlabs/proba-protocol` is pinned by release tag (`github:smallseedlabs/proba-protocol#v0.4.0`), never by raw commit.
- **Downstream allow-list.** The service may call only the hosts listed in `allowedDownstreamHosts` in the context config.

## Dependency audit

The `npm audit (high+)` job in `.github/workflows/security.yml` **reports** production advisories and raises a warning, but exits 0 so that it does not block merges.
The reason is `@smallseedlabs/proba-protocol`: it depends on zod 3, which `npm audit` flags as high severity (memory exhaustion while validating oversized constrained collections,
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)), and the fix is zod 4. There is no non-breaking fix this repository can apply on its own; it needs a protocol release that moves to zod 4.
Until then the advisory is tracked rather than gating, and the job's output is reviewed on each run. Phase 0 exposes only `GET /health` and validates no request bodies; once the context endpoint lands, `limits.maxRequestBytes` and `limits.maxNeedsPerRequest` bound what reaches schema validation.
Any other high or critical advisory that appears in the report must be fixed or explicitly accepted in a pull request.
