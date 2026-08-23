# DSH GoalMesh

Installable DeepSeek Harness composition bundle. It inserts the invariant registry,
GoalMesh Host tool, its invariant companion, and the Web trajectory companion as
one self-contained configuration layer.

The bundle implements the v0.3 foreground DAG scheduler, dependency and failure-mode
policies, local nested swarms with child-scoped leases, durable trajectory, trajectory
invariant, and Web Agent tree as one installable composition. Its default patch enables
`nestedMode: local-only` with the in-process `spawn` provider.
