# Contributing to DSH GoalMesh

Thank you for helping improve goal-driven multi-agent orchestration for DeepSeek Harness.

## Before you begin

GoalMesh is a DSH Plugin, not a Codex Plugin. Read
[`docs/architecture.md`](docs/architecture.md) before changing runtime behavior. The
architecture document is the implementation contract, especially around Cordis
lifecycle ownership, coordinator state, scoped leases, cancellation, and cleanup.

## Local setup

Clone GoalMesh and the pinned DeepSeek Harness baseline as sibling directories:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
git -C deepseek-harness checkout 47f943859bef60e4160492346772ded9b24f765a
git -C deepseek-harness submodule update --init --recursive
git clone https://github.com/Jarad-z/dsh-goalmesh.git
git -C deepseek-harness apply ../dsh-goalmesh/harness-patches/goalmesh-prerequisites.patch
cd dsh-goalmesh
corepack enable
corepack install --global pnpm@11.7.0
pnpm --dir ../deepseek-harness install --frozen-lockfile
pnpm --dir ../deepseek-harness run build:lib
pnpm install --frozen-lockfile
pnpm check
```

## Pull requests

- Keep the installable bundle, Host tool, and Web companion as separate packages.
- Preserve single-writer coordinator semantics.
- Bind every registration and live resource to its owning Cordis fiber.
- Add focused tests for behavior changes, including cancellation and cleanup paths.
- Update the architecture or execution plan when a public contract changes.
- Run `pnpm check` before submitting.
- Keep commits small, reviewable, and named for the behavior they introduce.

Bug reports should include the Harness commit, GoalMesh version, Profile configuration,
minimal reproduction, expected result, actual result, and relevant trajectory output.
