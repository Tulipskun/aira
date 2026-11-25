# Security policy

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in public issues or discussions.

Use the repository's **Security** tab and submit a private vulnerability report if private vulnerability reporting is available. Include the affected component, impact, reproduction steps, and any relevant version or commit. Do not include live Discord bot tokens, Gemini API keys, personal conversation data, or production database files in a report.

If private vulnerability reporting is unavailable, contact the repository maintainer privately through GitHub before publishing details. Please allow time for investigation and a fix before public disclosure.

## Sensitive runtime data

The following are private runtime data and must never be committed:

- `.env` and all Discord/Gemini credentials.
- `.aira/`, including SQLite databases, Chroma data, settings, key state, logs and Gemini debug payloads.
- Conversation exports, user identifiers where they are not required for a public test fixture, and production memory data.

Gemini debug payload recording is disabled by default. Enabling it can write conversation content and personal data to disk; enable it only temporarily and protect/delete the resulting files.

## Supported versions

Security fixes are currently applied to the latest `main` branch. No older release line is currently designated as supported.
