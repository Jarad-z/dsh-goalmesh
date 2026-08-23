import { rm } from 'node:fs/promises'

await Promise.all([
  'packages/tool-goalmesh/lib',
  'packages/client-ui-goalmesh/lib',
].map(path => rm(new URL(`../${path}`, import.meta.url), { recursive: true, force: true })))
