# dsh-tool-agent-swarm

Host-side DeepSeek Harness plugin for bounded, foreground Agent Swarm execution.

Version 0.1 exposes one fixed-batch `agent_swarm` tool. It validates the complete
batch before admission, starts child agents through a configured Subagent provider,
collects every direct structured `TaskReport` in input order, and appends an ignorable
durable trajectory to the calling Session. Nested swarm calls, dependencies, retries,
fail-fast, and quorum are intentionally unavailable in this version.

The `dsh-tool-agent-swarm/invariant` entry validates trajectory event ordering and
state transitions during publication and replay.
