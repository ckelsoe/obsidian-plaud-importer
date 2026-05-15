# Security Policy

## Supported Versions

Plaud Importer is in early alpha. Only the latest released version receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Plaud Importer, please report it responsibly:

1. **DO NOT** create a public GitHub issue for security vulnerabilities.
2. Email the details to the maintainer at: support@kelsoe.com
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to expect

- Acknowledgment within 48 hours
- Assessment and response within 7 days
- Security patch released as soon as possible
- Credit given to the reporter (unless you prefer to remain anonymous)

## Security Considerations

This plugin:

- Authenticates to Plaud.AI using a session token (JWT) that you supply.
- Stores that token via Obsidian's `SecretStorage` API. The token is never written to `data.json` and never written to logs.
- Communicates only with Plaud.AI (`api.plaud.ai`) and the content-delivery hosts that Plaud's API points at for attachment downloads.
- Writes imported notes and attachments into your vault through the Obsidian `Vault` API. It performs no direct filesystem access.
- Collects no telemetry and contacts no maintainer-operated server.

Your Plaud token is a full web-session credential, not a scoped API key. Treat it like your Plaud password:

- Never paste it into a public GitHub issue, discussion, or pull request.
- The opt-in debug log redacts auth headers automatically, but review any log, screenshot, or generated note before sharing it.

See [PRIVACY.md](./PRIVACY.md) for the full data-handling policy and liability disclaimer.
