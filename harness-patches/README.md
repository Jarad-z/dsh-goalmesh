# DeepSeek Harness prerequisites

GoalMesh v0.3 targets the public DeepSeek Harness `0.1.0-rc.5` baseline at
`47f943859bef60e4160492346772ded9b24f765a`. It additionally needs two narrow Host
capabilities that were developed against that baseline:

1. log-only Session events may opt into `{ ignorable: true }`;
2. an in-process Subagent request may install a publication-safe, one-shot
   `scopedSetup`.

[`goalmesh-prerequisites.patch`](goalmesh-prerequisites.patch) contains only the
runtime changes needed for those contracts. It deliberately omits the originating
Harness commits' documentation, generated API catalog, and Harness-owned tests so this
plugin repository does not vendor unrelated Harness source history.

Apply it to a clean checkout of the pinned public baseline:

```sh
git -C deepseek-harness checkout 47f943859bef60e4160492346772ded9b24f765a
git -C deepseek-harness submodule update --init --recursive
git -C deepseek-harness apply --check ../dsh-goalmesh/harness-patches/goalmesh-prerequisites.patch
git -C deepseek-harness apply ../dsh-goalmesh/harness-patches/goalmesh-prerequisites.patch
```

The CI workflow performs the same check before installing GoalMesh. Remove this patch
once an official Harness release provides an equivalent `scopedSetup` contract and the
plugin has been migrated and reverified against it.

For compatibility with the pinned baseline, `SubagentCapabilities.scopedSetup` is an optional advertisement: supporting providers set it to `true`, while existing providers that omit it are treated as unsupported.
