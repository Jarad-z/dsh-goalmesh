import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const harnessTsconfig = fileURLToPath(new URL('../deepseek-harness/tsconfig.base.json', import.meta.url))
const harnessRoot = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))
const loaded = ts.readConfigFile(harnessTsconfig, ts.sys.readFile)
if (loaded.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
const paths = loaded.config.compilerOptions?.paths as Record<string, [string]> | undefined
if (paths === undefined) throw new Error('Harness tsconfig has no path facade')
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const aliases = Object.entries(paths).map(([specifier, [target]]) => {
  const wildcard = specifier.endsWith('/*')
  const find = wildcard
    ? new RegExp(`^${escapeRegExp(specifier.slice(0, -1))}(.+)$`)
    : new RegExp(`^${escapeRegExp(specifier)}$`)
  const replacement = resolve(harnessRoot, target).replace('*', '$1')
  return { find, replacement }
})

export default defineConfig({
  resolve: { alias: aliases },
})
