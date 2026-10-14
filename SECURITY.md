# Security Policy

## Supported versions

Only the latest release on the `main` branch is supported with security fixes.


## Reporting a vulnerability

Please report vulnerabilities privately via the [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) feature on this repository (Security tab → Report a vulnerability). Include steps to reproduce and the affected version. You should receive a response within a few days.

## Scope

This policy covers the FlowMind application code in this repository; it does not cover third-party dependencies or hosting providers, which should be reported upstream.

## Personal AI keys (BYOK)

Workspace members' personal Gemini API keys are encrypted at rest with AES-256-GCM using the server's `FLOWMIND_ENCRYPTION_KEY` and are never returned to the browser in full — the API exposes only a masked hint. Keys travel to Google only over TLS when making AI requests. Treat `FLOWMIND_ENCRYPTION_KEY` as a production secret: it lives only in the server environment, and rotating it makes previously stored personal keys unreadable (they are then treated as absent until re-entered).
