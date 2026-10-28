import type { Rspack } from '@rsbuild/core'
import { describe, expect, it, rs } from '@rstest/core'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { resolve as resolvePosix } from 'pathe'
import {
  getIsExternal,
  resolveExternalModule,
  resolveWithExtensions,
} from 'storybook/internal/mocking-utils'
import { RspackMockPlugin } from '../../src/plugins/rspack-mock-plugin'

rs.mock('storybook/internal/mocking-utils', { spy: true })

// `extractMockCalls` calls `telemetry('mocking', ...)` whenever it finds mocks, but nothing
// leaves this process: `telemetry()` gates on `globalThis.SB_TELEMETRY_STATE`, which only the
// CLI and the common preset ever set. Undefined here means every event is parked on
// `globalThis.SB_TELEMETRY_QUEUE` and never flushed. Setting `STORYBOOK_DISABLE_TELEMETRY`
// would not help either — `telemetry()` never reads it.

const fixtureDir = resolve(__dirname, '../fixtures/mock-plugin')

interface Resource {
  request: string
  context: string
  createData?: { resource?: string }
}

type InfrastructureLogger = ReturnType<
  Rspack.Compiler['getInfrastructureLogger']
>

/**
 * Applies the plugin against a stub compiler and returns handles on the parts under test: the
 * callback given to NormalModuleReplacementPlugin, a trigger for the mock-map refresh that
 * normally runs on beforeRun, and the debug messages the plugin logged.
 *
 * `debugMessages` captures failed resolutions. Spies on the resolution utilities verify that
 * unrelated requests never attempt resolution.
 */
function applyPlugin(
  previewConfig = 'preview-with-mock.ts',
  context = fixtureDir,
) {
  const infoMessages: string[] = []
  const debugMessages: string[] = []
  const warnMessages: string[] = []
  let replaceResource: ((resource: Resource) => void) | undefined
  let refreshMocks: (() => void) | undefined

  // Drives the mtime the plugin sees, standing in for the compiler's cached file system.
  let previewMtime = 1_000

  const compilerStub = {
    context,
    inputFileSystem: {
      statSync: () => ({ mtime: new Date(previewMtime) }),
    } as unknown as Rspack.Compiler['inputFileSystem'],
    hooks: {
      beforeRun: {
        tap: (_name: string, fn: () => void) => {
          refreshMocks = fn
        },
      },
      watchRun: { tap: () => {} },
      afterCompile: { tap: () => {} },
    } as unknown as Rspack.Compiler['hooks'],
    getInfrastructureLogger: () =>
      ({
        info: (message: string) => infoMessages.push(message),
        warn: (message: string) => warnMessages.push(message),
        debug: (message: string) => debugMessages.push(message),
      }) as unknown as InfrastructureLogger,
    // The plugin reads `NormalModuleReplacementPlugin` off the compiler, so the stub can hand
    // it a recorder and keep hold of the replacement callback. Nothing global is touched.
    webpack: {
      NormalModuleReplacementPlugin: class {
        constructor(_test: RegExp, callback: (resource: Resource) => void) {
          replaceResource = callback
        }
        apply() {}
      },
    } as unknown as Rspack.Compiler['webpack'],
  } satisfies Partial<Rspack.Compiler>

  // `Rspack.Compiler` declares a private field, so it is nominally typed and no object literal
  // can be asserted to it directly. The `satisfies` above is what type-checks the stub.
  const compiler = compilerStub as unknown as Rspack.Compiler

  new RspackMockPlugin({
    previewConfigPath: resolve(context, previewConfig),
  }).apply(compiler)

  if (!replaceResource || !refreshMocks) {
    throw new Error('plugin did not register its replacement callback')
  }
  const runUpdateMocks = refreshMocks

  runUpdateMocks()

  // A warning here means mock resolution itself failed, which would make every assertion below
  // pass for the wrong reason.
  if (warnMessages.length > 0) {
    throw new Error(
      `plugin warned while resolving mocks: ${warnMessages.join('; ')}`,
    )
  }

  /**
   * Runs another compilation, optionally after the preview config has been rewritten. The plugin
   * logs once per rebuild of a non-empty map, so `rebuildCount` reports whether it re-extracted.
   */
  const recompile = (mtime = previewMtime) => {
    previewMtime = mtime
    runUpdateMocks()
  }

  return {
    replaceResource,
    recompile,
    debugMessages,
    rebuildCount: () => infoMessages.length,
  }
}

describe('RspackMockPlugin', () => {
  it('does not resolve anything when no mocks are declared', () => {
    const { replaceResource, debugMessages } = applyPlugin(
      'preview-without-mock.ts',
    )
    const resource = { request: './not-a-real-module', context: fixtureDir }

    replaceResource(resource)

    expect(resource.request).toBe('./not-a-real-module')
    expect(debugMessages).toEqual([])
  })

  it('skips requests that cannot resolve to a mocked module', () => {
    const { replaceResource, debugMessages } = applyPlugin(
      'preview-with-mock.ts',
    )

    rs.clearAllMocks()

    for (const request of [
      './not-a-real-module',
      '@/not-a-real-alias',
      'react',
    ]) {
      const resource = { request, context: fixtureDir }

      replaceResource(resource)

      expect(resource.request).toBe(request)
    }
    expect(debugMessages).toEqual([])
    expect(getIsExternal).not.toHaveBeenCalled()
    expect(resolveWithExtensions).not.toHaveBeenCalled()
    expect(resolveExternalModule).not.toHaveBeenCalled()

    // Control: a mocked request does reach the spied resolver.
    replaceResource({ request: './mocked-module', context: fixtureDir })

    expect(resolveWithExtensions).toHaveBeenCalled()
  })

  it('mocks requests only before they are resolved', () => {
    const { replaceResource } = applyPlugin('preview-with-mock.ts')
    // Rspack calls the plugin again after resolution, with `createData.resource` set.
    const before = {
      request: './mocked-module',
      context: fixtureDir,
      createData: {},
    }
    const after = {
      request: './mocked-module',
      context: fixtureDir,
      createData: { resource: resolve(fixtureDir, 'mocked-module.js') },
    }

    replaceResource(before)
    replaceResource(after)

    expect(before.request).toBe(
      resolvePosix(fixtureDir, '__mocks__/mocked-module.js'),
    )
    expect(after.request).toBe('./mocked-module')
  })

  it('still mocks directory imports, package links and symlinked directories', () => {
    const { replaceResource } = applyPlugin('preview-with-mock.ts')
    const directoryResource = { request: './mocked-dir', context: fixtureDir }

    replaceResource(directoryResource)

    expect(directoryResource.request).toBe(
      resolvePosix(fixtureDir, 'mocked-dir/__mocks__/index.js'),
    )

    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'rspack-mock-plugin-')),
    )
    const modules = join(root, 'node_modules')
    const link = join(modules, 'mock-plugin-fixture')
    try {
      mkdirSync(modules)
      symlinkSync(fixtureDir, link, 'junction')

      const packageResource = {
        request: 'mock-plugin-fixture/mocked-module',
        context: root,
      }
      replaceResource(packageResource)
      expect(packageResource.request).toBe(
        resolvePosix(fixtureDir, '__mocks__/mocked-module.js'),
      )

      const linkedResource = { request: './mocked-module', context: link }
      replaceResource(linkedResource)
      expect(linkedResource.request).toBe(
        resolvePosix(fixtureDir, '__mocks__/mocked-module.js'),
      )

      // `require.resolve` joins a request to its context before following symlinks.
      for (const resource of [
        {
          request: `${relative(link, fixtureDir)}/mocked-module`,
          context: link,
        },
        { request: join(link, 'mocked-module'), context: root },
        {
          request: './node_modules/mock-plugin-fixture/mocked-module',
          context: root,
        },
      ]) {
        replaceResource(resource)
        expect(resource.request).toBe(
          resolvePosix(fixtureDir, '__mocks__/mocked-module.js'),
        )
      }
    } finally {
      // Remove the link first, so the recursive removal never reaches the fixtures it points to.
      rmSync(link, { force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refreshes directory links when the preview is unchanged', () => {
    const { replaceResource, recompile } = applyPlugin('preview-with-mock.ts')
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'rspack-mock-plugin-relink-')),
    )
    const unmocked = join(root, 'unmocked')
    const link = join(root, 'relinked')
    try {
      mkdirSync(unmocked)
      symlinkSync(unmocked, link, 'junction')
      const before = { request: './mocked-module', context: link }

      replaceResource(before)

      expect(before.request).toBe('./mocked-module')

      rmSync(link)
      symlinkSync(fixtureDir, link, 'junction')
      recompile()
      const after = { request: './mocked-module', context: link }

      replaceResource(after)

      expect(after.request).toBe(
        resolvePosix(fixtureDir, '__mocks__/mocked-module.js'),
      )
    } finally {
      // Remove the link first, so recursive removal cannot reach the committed fixtures.
      rmSync(link, { force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  // `pathe` is a real dependency, so getIsExternal reports it as external and it takes the
  // candidateSpecifiers path. This pins the outcome, not the shortcut: skipping the resolve is an
  // optimisation, so removing it would leave this request untouched either way.
  it('leaves bare specifiers that are not mocked alone', () => {
    const { replaceResource } = applyPlugin('preview-with-mock.ts')
    const resource = { request: 'pathe', context: fixtureDir }

    replaceResource(resource)

    expect(resource.request).toBe('pathe')
  })

  it('redirects a request that matches a declared mock', () => {
    const { replaceResource } = applyPlugin('preview-with-mock.ts')
    const resource = { request: './mocked-module', context: fixtureDir }

    replaceResource(resource)

    expect(resource.request).toBe(
      resolvePosix(fixtureDir, '__mocks__/mocked-module.js'),
    )
  })

  it('redirects an external package to its mock', () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'rspack-mock-plugin-external-')),
    )
    try {
      const files = {
        'package.json': JSON.stringify({ name: 'mock-plugin-project' }),
        'preview.ts': [
          "import { sb } from 'storybook/test'",
          "sb.mock('ext-pkg')",
        ].join('\n'),
        'node_modules/ext-pkg/package.json': JSON.stringify({
          name: 'ext-pkg',
        }),
        'node_modules/ext-pkg/index.js': "export const value = 'real'",
        '__mocks__/ext-pkg.js': "export const value = 'mocked'",
      }
      for (const [file, content] of Object.entries(files)) {
        const path = join(root, file)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
      }
      const { replaceResource } = applyPlugin(join(root, 'preview.ts'), root)
      const resource = { request: 'ext-pkg', context: root }

      replaceResource(resource)

      expect(resource.request).toBe(resolvePosix(root, '__mocks__/ext-pkg.js'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  describe('mock map caching', () => {
    it('reuses the map while the preview config mtime is unchanged', () => {
      const { recompile, rebuildCount } = applyPlugin('preview-with-mock.ts')

      recompile()

      expect(rebuildCount()).toBe(1)
    })

    it('rebuilds the map when the preview config mtime changes', () => {
      const { recompile, rebuildCount } = applyPlugin('preview-with-mock.ts')

      recompile(2_000)

      expect(rebuildCount()).toBe(2)
    })

    // Equality rather than "newer", so restoring an older preview config is still picked up.
    it('rebuilds the map when the preview config mtime goes backwards', () => {
      const { recompile, rebuildCount } = applyPlugin('preview-with-mock.ts')

      recompile(500)

      expect(rebuildCount()).toBe(2)
    })
  })
})
