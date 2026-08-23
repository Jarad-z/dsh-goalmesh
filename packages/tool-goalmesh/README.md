# dsh-tool-goalmesh

Host-side DeepSeek Harness plugin for bounded, foreground GoalMesh execution.

Version 0.3 exposes one foreground `goal_mesh` tool. It atomically validates an
invocation-local DAG, starts ready child agents through a configured Subagent provider,
materializes settled dependency summaries, and preserves direct `TaskReport` results in
input order. Dependency failures can fail, skip, or partially unblock downstream work;
the invocation can collect all results, fail fast, or stop after a quorum. With
`nestedMode: local-only`, each local child receives a same-name scoped Tool backed by an
attempt-fenced lease. Nested invocations share the root goal and scheduler, release the
parent permit while waiting, and return only after the parent reacquires a permit.
Providers without `scopedSetup` are rejected in nested mode. Automatic task retries
remain intentionally unavailable.

The `dsh-tool-goalmesh/invariant` entry validates trajectory event ordering,
waiting/ready and nested wait/resume transitions, dependency and parent ownership,
attempt closure, and terminal closure during publication and replay.
