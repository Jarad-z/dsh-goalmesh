import { rm } from 'node:fs/promises'

await Promise.all([
  'packages/tool-agent-swarm/lib',
  'packages/client-ui-agent-swarm/lib',
].map(path => rm(new URL(`../${path}`, import.meta.url), { recursive: true, force: true })))
