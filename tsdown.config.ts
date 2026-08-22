import { readFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { TsdownPlugin, UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PACKAGE_ID = 'dsh-product-subagent-console'
const CSS_MODULE_PREFIX = '\0dsh-product-subagent-console:module:'
const CSS_GLOBAL_PREFIX = '\0dsh-product-subagent-console:global:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
])

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('\0') && !isAbsolute(specifier)
}

function isClientExternal(specifier: string): boolean {
  if (isBuiltin(specifier) || specifier.startsWith('node:')) {
    throw new Error(`browser client cannot import Node.js builtin ${JSON.stringify(specifier)}`)
  }
  if (
    (specifier === 'react' || specifier.startsWith('react/'))
    || (specifier === 'react-dom' || specifier.startsWith('react-dom/'))
    || specifier.startsWith('@deepseek-ai/')
  ) {
    if (!CLIENT_EXTERNALS.has(specifier)) {
      throw new Error(`browser client dependency is not in the audited external allowlist: ${JSON.stringify(specifier)}`)
    }
    return true
  }
  return false
}

function sourceAssetPath(source: string, importer: string): string {
  return isBareSpecifier(source)
    ? createRequire(importer).resolve(source)
    : resolve(dirname(importer), source)
}

function styleModule(
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const tagId = `${PACKAGE_ID}/${basename(fileId)}`
  const lines = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  lines.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return lines.join('\n')
}

const cssPlugin: TsdownPlugin = {
  name: 'dsh-product-subagent-console-css',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.css') || importer === undefined) return null
    const file = sourceAssetPath(source, importer)
    const prefix = source.endsWith('.module.css') ? CSS_MODULE_PREFIX : CSS_GLOBAL_PREFIX
    return prefix + file + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId: string) {
    const moduleCss = virtualId.startsWith(CSS_MODULE_PREFIX)
    const globalCss = virtualId.startsWith(CSS_GLOBAL_PREFIX)
    if (!moduleCss && !globalCss) return null
    const prefix = moduleCss ? CSS_MODULE_PREFIX : CSS_GLOBAL_PREFIX
    const fileId = virtualId.slice(prefix.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(fileId)
    const result = transform({
      filename: fileId,
      code: await readFile(fileId),
      minify: true,
      ...moduleCss ? { cssModules: { pattern: '[hash]_[local]' } } : {},
    })
    if (!moduleCss) return styleModule(fileId, result.code.toString())
    const classMap: Record<string, string> = {}
    for (const [local, value] of Object.entries(result.exports ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      classMap[local] = value.name
    }
    return styleModule(fileId, result.code.toString(), classMap)
  },
}

const nodeConfig: UserConfig = {
  name: PACKAGE_ID,
  entry: {
    index: 'src/index.ts',
    tool: 'src/tool.ts',
    invariant: 'src/invariant.ts',
    planner: 'src/planner.ts',
    'plan-tool': 'src/plan-tool.ts',
    types: 'src/types.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  clean: false,
  dts: false,
  sourcemap: false,
  deps: {
    neverBundle: specifier => isBuiltin(specifier) || isBareSpecifier(specifier),
    alwaysBundle: specifier => !isBuiltin(specifier) && !isBareSpecifier(specifier),
  },
  inputOptions: {
    experimental: {
      attachDebugInfo: 'none',
    },
  },
  outputOptions: {
    entryFileNames: '[name].js',
  },
}

const clientConfig: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  clean: false,
  dts: false,
  sourcemap: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  deps: {
    neverBundle: specifier => isClientExternal(specifier),
    alwaysBundle: specifier => !isClientExternal(specifier),
  },
  plugins: [cssPlugin],
  inputOptions: {
    experimental: {
      attachDebugInfo: 'none',
    },
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default [nodeConfig, clientConfig]
