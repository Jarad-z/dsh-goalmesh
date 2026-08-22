# dsh-client-ui-agent-swarm

DeepSeek Harness Web companion for `dsh-tool-agent-swarm` durable trajectory events.

The browser entry folds live appends, full replay, and paginated history prepend into
the same keyed Chat node. It renders a bounded Agent task tree with task and attempt
details, nested parent/child lineage, wait/resume states, horizontal
dependencies/dependents, deadlock audit and interruption diagnostics, and child Session
navigation only when the ordinary Session list or the direct-child catalog proves the
recorded parent/child lineage.

The package's Node entry is intentionally inert; DSH loads the `./client` artifact only
in Web profiles.
