# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through
[GitHub Security Advisories](https://github.com/itsshreyasbhardwaj-design/autodev-ci/security/advisories/new).

Please include:

- what the vulnerability allows an attacker to do;
- the affected component and version;
- a reproduction, ideally minimal;
- any mitigation you have already identified.

You can expect an acknowledgement within 48 hours and an assessment with a
planned fix date within 5 working days. We will credit you in the advisory
unless you prefer otherwise.

## Threat model

AutoDev CI runs against repositories containing code that may be written by
anyone, including an attacker who opened a pull request specifically to attack
the reviewer. The design assumes that.

### Untrusted inputs

Everything below is attacker-controlled and treated as data, never as
instruction:

- pull request titles, descriptions and comments
- file contents and diffs
- commit messages
- branch names
- `.autodev.yml` in the analysed repository

### Defences

**Prompt injection.** The primary defence is structural: a language model cannot
set a severity, fail a gate, or change a verdict. Those come from deterministic
code. In addition, untrusted content is wrapped in per-process random delimiters,
the system prompt states that delimited content is data, known injection
phrasings are neutralised before the model sees them, and model-supplied
severities are clamped so an AI finding can never be `critical`.

**Code execution.** AutoDev CI never executes code from an analysed repository.
Analysis is pattern matching over text. There is no sandbox to escape because
nothing runs.

**Webhook forgery.** Deliveries are verified with HMAC-SHA256 against the raw
request body using a constant-time comparison. Delivery ids are recorded so a
replayed delivery is a no-op. When `GITHUB_WEBHOOK_SECRET` is unset the platform
logs a warning and surfaces it on `/api/health` — never deploy that way.

**Credential handling.** Tokens are encrypted at rest with AES-256-GCM
(authenticated, so tampering is detected on decrypt). The logger redacts values
by key name at any depth. The repositories API strips `encryptedToken` from every
response. Secret scanner findings mask the matched value.

**Least privilege.** Reviews require only `contents: read` and
`pull-requests: write`. Write access to repository contents is used solely for
opening a documentation pull request, and only when you enable it.

**Rate limiting and resource bounds.** Requests are limited per API key or IP
with a sliding window. Pull requests are capped at 300 analysed files, full-file
fetches at 25, and AI prompts at an explicit token budget — a 5,000-file pull
request cannot exhaust the function timeout or the GitHub rate limit.

**Transport and headers.** A strict Content Security Policy, HSTS in production,
`X-Frame-Options: DENY`, `nosniff`, and a restrictive `Permissions-Policy` are
applied to every response.

### Out of scope

- Vulnerabilities in dependencies without a demonstrated exploit path here
  (please report those upstream)
- Social engineering of maintainers
- Attacks requiring an already-compromised deployment environment
- Missing findings from the analysis engine — it is a heuristic reviewer, not a
  security guarantee, and this is stated in the README

## Hardening a deployment

Before running this in production:

- [ ] Set `GITHUB_WEBHOOK_SECRET` so deliveries are verified.
- [ ] Set `AUTODEV_API_KEYS` so the REST API is not publicly writable.
- [ ] Set `ENCRYPTION_KEY` (`openssl rand -base64 32`) so tokens are encrypted.
- [ ] Set `DATABASE_URL` so data survives a restart.
- [ ] Configure an authentication provider so the dashboard is not public.
- [ ] Use a GitHub App rather than a personal access token.
- [ ] Review `/api/health` — it lists any of the above that is missing.
