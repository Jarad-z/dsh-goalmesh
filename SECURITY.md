# Security policy

## Supported versions

DSH GoalMesh is currently pre-1.0. Security fixes are applied to the latest `0.3.x`
line while the public runtime contract stabilizes.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting flow from the repository **Security** tab. Include:

- the affected GoalMesh and DeepSeek Harness versions;
- the threat model and impact;
- a minimal reproduction or proof of concept;
- whether the issue crosses Agent, Session, Tool, lease, or Profile boundaries;
- any proposed mitigation.

Security-sensitive areas include forged ownership identifiers, scoped-lease escape,
cross-Session trajectory trust, cancellation leaks, dependency-result injection,
unbounded output, and resources that survive their Cordis fiber.

We will acknowledge a complete report, reproduce it, assess severity, and coordinate a
fix before public disclosure.
