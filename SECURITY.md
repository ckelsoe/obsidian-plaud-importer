# Security Policy

## Supported Versions

The Shell Path Copy plugin follows a simple versioning scheme. Only the latest version receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Shell Path Copy, please report it responsibly:

1. **DO NOT** create a public GitHub issue for security vulnerabilities
2. Email the details to the maintainer at: support@kelsoe.com
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to expect:

- Acknowledgment within 48 hours
- Assessment and response within 7 days
- Security patch released as soon as possible
- Credit given to reporter (unless you prefer to remain anonymous)

## Security Considerations

This plugin:

- Only reads file paths and copies them to the clipboard
- Does not execute shell commands
- Does not modify files
- Does not transmit data externally
- Has no network capabilities

The primary security consideration is ensuring paths with special characters are properly escaped when used in shell commands (which is the user's responsibility after copying).