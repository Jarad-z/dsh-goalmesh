# dsh-tool-agent-swarm

Host-side DeepSeek Harness plugin for bounded, foreground Agent Swarm execution.

Version 0.2 exposes one foreground `agent_swarm` tool. It atomically validates an
invocation-local DAG, starts ready child agents through a configured Subagent provider,
materializes settled dependency summaries, and preserves direct `TaskReport` results in
input order. Dependency failures can fail, skip, or partially unblock downstream work;
the invocation can collect all results, fail fast, or stop after a quorum. Nested swarm
calls and automatic task retries remain intentionally unavailable in this version.

The `dsh-tool-agent-swarm/invariant` entry validates trajectory event ordering,
waiting/ready transitions, dependency ownership, and terminal closure during
publication and replay.
