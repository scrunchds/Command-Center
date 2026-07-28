# Security Policy

## Supported versions

Security fixes are applied to the latest published release and the `main` branch. Older releases may not receive patches.

| Version | Supported |
|---|---|
| Latest release | Yes |
| `main` | Yes |
| Older releases | No |

## Reporting a vulnerability

**Do not open a public issue or discussion for a suspected vulnerability.** Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Select **Advisories**.
3. Select **Report a vulnerability**.

Include:

- A clear description and potential impact
- Affected versions, components, and configuration
- Reproduction steps or a minimal proof of concept
- Suggested remediation, if known
- Whether the report or exploit details have been disclosed elsewhere

Do not include real API keys, private vault contents, personal information, or third-party secrets. Use synthetic data and revoke any credential that may have been exposed.

## Response process

The maintainer will aim to:

- Acknowledge a complete report within 5 business days
- Triage severity and reproducibility within 10 business days
- Keep the reporter informed when material progress occurs
- Coordinate a fix and disclosure timeline based on risk and complexity
- Credit the reporter in an advisory or release notes if requested and appropriate

These are best-effort targets, not a service-level agreement. Duplicate, non-reproducible, out-of-scope, or purely theoretical reports may be closed with an explanation.

## Scope

Security-sensitive areas include credential storage, provider authentication, vault file access and mutation, Markdown rendering, subprocess/RPC execution, URL handling, workflow parsing, release artifacts, and dependency or build-chain integrity.

Reports requiring access to a user's already-compromised device, social engineering, denial of service without meaningful security impact, or vulnerabilities solely in unsupported third-party software may be considered out of scope.

## Safe harbor

Good-faith research that avoids privacy violations, data destruction, service disruption, persistence, and access beyond what is necessary to demonstrate the issue will not be pursued by the project. Follow applicable laws and give the maintainer reasonable time to remediate before public disclosure.
