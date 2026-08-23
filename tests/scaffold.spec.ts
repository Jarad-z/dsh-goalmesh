import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>
}

describe('three-package scaffold', () => {
  it('publishes one bundle with its registry and two runtime packages as dependencies', async () => {
    const manifest = await json('../packages/goalmesh-plugin/package.json')
    expect(manifest.name).toBe('dsh-goalmesh-plugin')
    expect(manifest.dsh).toEqual({ bundle: { patch: './cordis.patch.yml' } })
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh-invariants': '^0.1.0-rc.5',
      'dsh-client-ui-goalmesh': 'workspace:^',
      'dsh-tool-goalmesh': 'workspace:^',
    })
  })

  it('inserts the invariant registry, Host, companion, and Web entries exactly once', async () => {
    const source = await readFile(new URL('../packages/goalmesh-plugin/cordis.patch.yml', import.meta.url), 'utf8')
    const patch = parse(source) as Array<{ insert: Array<{ id: string; name: string; config?: unknown }> }>
    expect(patch).toHaveLength(1)
    expect(patch[0]?.insert.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'goalmesh-invariants', name: '@deepseek-ai/dsh-invariants' },
      { id: 'goalmesh', name: 'dsh-tool-goalmesh' },
      { id: 'goalmesh-invariant', name: 'dsh-tool-goalmesh/invariant' },
      { id: 'ui-goalmesh', name: 'dsh-client-ui-goalmesh' },
    ])
    expect(patch[0]?.insert.find(entry => entry.id === 'goalmesh')?.config).toEqual({
      provider: 'spawn',
      nestedMode: 'local-only',
      maxConcurrency: 4,
      maxTasks: 64,
      maxDepth: 3,
      swarmTimeoutMs: 900000,
      attemptTimeoutMs: 300000,
      maxTaskReportChars: 12000,
      maxRenderedResultChars: 50000,
    })
  })

  it('declares the Web module graph metadata', async () => {
    const manifest = await json('../packages/client-ui-goalmesh/package.json')
    expect(manifest.dsh).toEqual({
      client: {
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-runtime',
          '@deepseek-ai/dsh-client-ui-conversation',
        ],
        platform: 'web',
      },
    })
  })

  it('builds every package entry and a ModuleLoader-compatible browser bundle', async () => {
    const paths = [
      'packages/tool-goalmesh/lib/index.js',
      'packages/tool-goalmesh/lib/invariant.js',
      'packages/client-ui-goalmesh/lib/index.js',
      'packages/client-ui-goalmesh/lib/client.js',
    ]
    await Promise.all(paths.map(path => access(new URL(`../${path}`, import.meta.url))))
    const client = await readFile(new URL('../packages/client-ui-goalmesh/lib/client.js', import.meta.url), 'utf8')
    expect(client).toContain('window.__ModuleLoader__.load({')
    expect(client).toContain('id: "dsh-client-ui-goalmesh"')
  })
})
