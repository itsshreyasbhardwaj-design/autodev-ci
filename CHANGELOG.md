# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 (2026-07-25)

Initial release.

### ✨ Features

- **analysis:** Ten deterministic analyzers covering secrets, vulnerability
  patterns, prompt injection, error handling, performance, complexity,
  duplication, dependencies, testing and documentation drift
- **quality-gates:** Configurable severity, security, change size, test
  coverage, documentation, duplication and complexity gates, where only
  high-confidence deterministic findings can block a merge
- **github:** GitHub App and personal access token authentication, HMAC-verified
  webhooks with delivery de-duplication, a unified diff parser with correct
  GitHub review positions, and in-place updating review comments
- **ai:** Provider abstraction with an OpenRouter client and a deterministic
  offline provider, streaming support, and prompt-injection hardening
- **changelog:** Conventional Commits parser, semantic version inference,
  changelog rendering and idempotent `CHANGELOG.md` updating
- **release:** Release notes, upgrade guide, breaking change summary, migration
  guide and a deployment checklist derived from what actually changed
- **health:** Seven-dimension repository health scoring with trends and
  leverage-ranked recommendations
- **api:** Documented REST API with validation, rate limiting, typed errors and
  server-sent event streaming
- **dashboard:** Next.js App Router dashboard covering the pull request queue,
  reviews, findings, health, releases, documentation and settings
- **cli:** `autodev` command with `review`, `changelog`, `release`, `health` and
  `docs`, plus a composite GitHub Action wrapping it
- **notifications:** GitHub comments, Slack, Microsoft Teams, generic webhook and
  email channels behind one interface

### 📚 Documentation

- Comprehensive README, contributing guide, security policy, code of conduct and
  issue and pull request templates
