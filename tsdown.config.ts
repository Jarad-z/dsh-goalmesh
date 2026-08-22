import { defineConfig } from 'tsdown'

const hostRoot = 'packages/tool-agent-swarm'
const webRoot = 'packages/client-ui-agent-swarm'
const webPackage = 'dsh-client-ui-agent-swarm'

export default defineConfig([
  {
    name: 'dsh-tool-agent-swarm',
    entry: {
      index: `${hostRoot}/src/index.ts`,
      invariant: `${hostRoot}/src/invariant.ts`,
    },
    outDir: `${hostRoot}/lib`,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    deps: { neverBundle: [/^@deepseek-ai\//, 'zod'] },
    dts: false,
    clean: false,
  },
  {
    name: webPackage,
    entry: { index: `${webRoot}/src/index.ts` },
    outDir: `${webRoot}/lib`,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${webPackage}/client`,
    entry: { client: `${webRoot}/src/client/index.ts` },
    outDir: `${webRoot}/lib`,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    deps: {
      neverBundle: [
        /^react(?:\/|$)/,
        '@deepseek-ai/dsh-client-runtime/client',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
    },
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(webPackage)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
