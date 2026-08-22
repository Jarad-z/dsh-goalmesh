# DSH Agent Swarm Plugin

Agent Swarm is a DeepSeek Harness Plugin that exposes bounded, foreground
subagent orchestration as one model-facing tool and render its durable trajectory
in the Web client.

This repository deliberately separates three package roles:

- `dsh-agent-swarm-plugin`: the installable composition bundle;
- `dsh-tool-agent-swarm`: the Host tool and invariant companion;
- `dsh-client-ui-agent-swarm`: the inert Node entry and browser companion.

Version 0.2 includes the Host DAG scheduler, dependency-result materialization,
fail/skip/partial propagation, collect-all/fail-fast/quorum policies, durable
trajectory and invariant companion, plus the Web Agent tree with trusted
child-Session navigation. Nested swarms land in the remaining numbered commits in
[`docs/execution-plan.md`](docs/execution-plan.md). The normative design is
[`docs/architecture.md`](docs/architecture.md).

## Development

Requirements: Node.js 22.19 or newer and pnpm 11.7.

```sh
pnpm install
pnpm check
```

The build emits Host entries under `packages/tool-agent-swarm/lib/` and the Web
Node/client entries under `packages/client-ui-agent-swarm/lib/`. The browser
artifact uses the DSH `window.__ModuleLoader__` closure format; it is not a
standalone browser script.

To inspect distribution contents, build first and run `pnpm pack` in each package.
The bundle tarball must contain `index.js` and `cordis.patch.yml`; the runtime
tarballs must contain their declared `lib/` exports.
