/**
 * Client-bundle build for the browser half.
 *
 * Mirrors the DeepSeek Harness monorepo `clientBundle` preset (packages/client/
 * tsdown.client.ts) for an EXTERNAL package: emits one closure-factory artifact
 * `lib/client.js` that registers with `window.__ModuleLoader__.load({id, factory})`
 * and resolves platform externals (react, cordis, ui-slots…) through the injected
 * require — the loader module table seeded by the DSH web boot graph.
 *
 * The node half is built by tsc (see package.json build:types / build:js);
 * `clean` must stay off so tsdown does not wipe those artifacts.
 */
import { defineConfig } from 'tsdown'

/** Plugin id — also the package name stamped into the ModuleLoader handoff. */
const id = 'dsh-plugin-sops-vault'

/**
 * Platform seed modules: provided by the boot graph, never bundled.
 * Copied from the monorepo PLATFORM_MODULES list (packages/client/web/src/platform.ts).
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

export default defineConfig({
  name: `${id}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  // Platform seed modules come from the loader module table, never bundled.
  // Everything else inlines (this package has no third-party runtime deps;
  // a require() the table cannot answer would be a guaranteed runtime throw).
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
