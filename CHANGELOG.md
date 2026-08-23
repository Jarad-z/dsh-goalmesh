# Changelog

All notable changes to DSH GoalMesh are documented here.

## [Unreleased]

### Changed

- Renamed the project and public package family from Agent Swarm to DSH GoalMesh.
- Renamed the model-facing tool to `goal_mesh`.
- Added repository branding, CI, contribution guidance, and a security policy.

## [0.3.0] - 2026-08-22

### Added

- Local nested meshes attached to the same root goal through child-scoped leases.
- Parent execution-permit release and reacquisition around nested work.
- Attempt fencing, nested ownership checks, and trajectory invariants.

## [0.2.0] - 2026-08-22

### Added

- Invocation-local DAG scheduling and dependency-result materialization.
- Fail, skip, and partial dependency propagation.
- Collect-all, fail-fast, and quorum completion policies.

## [0.1.0] - 2026-08-22

### Added

- Bounded foreground subagent scheduling.
- Typed task reports, cancellation, timeout, and deterministic result ordering.
- Durable trajectory events and the DSH Web task tree.
