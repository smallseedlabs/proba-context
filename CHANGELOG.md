# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Phase 0 scaffold: npm workspaces monorepo with `packages/core`, `packages/adapters` and `apps/context-api`.
- Core ports (conversation, task state, memory, audit history, analytics, policy, tool catalog, cache, tokenizer, audit emitter, clock, identity resolver).
- Config schema and YAML loader with clear validation errors, plus versioned templates for all eight step types.
- Deterministic packet hashing (`canonicalizeForHash`, `computePacketHash`).
- `context-api` Fastify service with `GET /health` on port 3500.
- Docker image, loopback-only compose file with required credentials, CI (lint, type check, unit tests, compose security, Docker build) and security workflows (gitleaks, npm audit report, CodeQL).
