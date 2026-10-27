import type { Rspack } from '@rsbuild/core'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  babelParser,
  extractMockCalls,
  findMockRedirect,
  getIsExternal,
  resolveExternalModule,
  resolveWithExtensions,
} from 'storybook/internal/mocking-utils'

const PLUGIN_NAME = 'RspackMockPlugin'

const RELATIVE_REQUEST = /^\.\.?(?:[/\\]|$)/

/**
 * Paths that a relative or absolute request can join to and still resolve to `path`: the path and
 * each prefix that ends before a `/` or a `.`, because resolution adds extensions, `index` files
 * and package entry points.
 */
function getRequestPaths(path: string): string[] {
  const paths = [path]
  for (let index = 1; index < path.length; index++) {
    if (path[index] === '.' || path[index] === '/') {
      paths.push(path.slice(0, index))
    }
  }
  return paths
}

/** The `name` of every package.json from `dir` up to the file system root. */
function getPackageNames(dir: string): string[] {
  const names: string[] = []
  for (let current = dir; ; current = dirname(current)) {
    try {
      const { name } = JSON.parse(
        readFileSync(join(current, 'package.json'), 'utf-8'),
      )
      if (typeof name === 'string') {
        names.push(name)
      }
    } catch {
      // No package.json, or not one we can read.
    }
    if (dirname(current) === current) {
      return names
    }
  }
}

/** The package a bare request points into: `@scope/name` or `name`. */
function getPackageName(request: string): string {
  const [first, second] = request.split('/')
  return first.startsWith('@') && second ? `${first}/${second}` : first
}

/**
 * Normalize file paths to use forward slashes consistently across all platforms.
 * This is necessary because:
 * - `extractMockCalls` uses `pathe` which always returns forward slashes
 * - `resolveWithExtensions` uses Node's `require.resolve` which returns backslashes on Windows
 * Without this normalization, path comparison would fail on Windows.
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

export interface RspackMockPluginOptions {
  previewConfigPath: string
  configDir?: string
}

interface ExtractedMock {
  path: string
  spy: boolean
}

interface ResolvedMock extends ExtractedMock {
  absolutePath: string
  replacementResource: string
}

export class RspackMockPlugin {
  private readonly options: RspackMockPluginOptions
  private mockMap: Map<string, ResolvedMock> = new Map()
  private candidateSpecifiers: Set<string> = new Set()
  private mockRequestPaths: Set<string> = new Set()
  private mockPackageNames: Set<string> = new Set()
  private realDirectories: Map<string, string> = new Map()
  private lastPreviewMtime: number | undefined

  constructor(options: RspackMockPluginOptions) {
    if (!options.previewConfigPath) {
      throw new Error(`[${PLUGIN_NAME}] \`previewConfigPath\` is required.`)
    }
    this.options = options
  }

  apply(compiler: Rspack.Compiler) {
    const logger = compiler.getInfrastructureLogger(PLUGIN_NAME)

    const updateMocks = () => {
      const mTimePreviewConfig = this.getPreviewConfigMtime(compiler)
      if (
        this.lastPreviewMtime !== undefined &&
        mTimePreviewConfig !== undefined &&
        mTimePreviewConfig === this.lastPreviewMtime
      ) {
        return // unchanged
      }

      const resolved = this.extractAndResolveMocks(compiler)
      this.mockMap = new Map(
        resolved.flatMap((mock) => [
          [normalizePath(mock.absolutePath), mock],
          [normalizePath(mock.absolutePath.replace(/\.[^.]+$/, '')), mock],
        ]),
      )
      // TODO: `mock.path` is not the specifier the user wrote. `extractMockCalls`
      // strips the extension when the declared specifier's basename matches the
      // resolved file's basename, so `sb.mock('pkg/dist/index.js')` is stored as
      // `pkg/dist/index` while `resource.request` keeps the `.js`. The pre-filter
      // below then misses that request and silently skips a mock it was never meant
      // to drop. Register the extension-bearing form here as well.
      // (builder-webpack5 has the same bug: webpack-mock-plugin.ts:86 on `next`.)
      // See https://github.com/rstackjs/storybook-rsbuild/pull/524#discussion_r3688976092
      this.candidateSpecifiers = new Set(resolved.map((mock) => mock.path))
      this.mockRequestPaths = new Set(
        resolved.flatMap((mock) =>
          getRequestPaths(normalizePath(resolve(mock.absolutePath))),
        ),
      )
      this.mockPackageNames = new Set(
        resolved.flatMap((mock) => getPackageNames(dirname(mock.absolutePath))),
      )
      this.realDirectories.clear()
      this.lastPreviewMtime = mTimePreviewConfig

      if (resolved.length > 0) {
        logger.info(`Mock map updated with ${resolved.length} mocks.`)
      }
    }

    compiler.hooks.beforeRun.tap(PLUGIN_NAME, updateMocks)
    compiler.hooks.watchRun.tap(PLUGIN_NAME, updateMocks)

    // Taken from the compiler rather than the module-level `rspack` namespace, matching
    // upstream's webpack5 builder. It keeps the plugin bound to the compiler that is actually
    // running it, and lets tests supply the constructor instead of patching a shared export.
    new compiler.webpack.NormalModuleReplacementPlugin(/.*/, (resource) => {
      try {
        // Skip the resolution probe entirely when no `sb.mock()` calls are declared —
        // otherwise every request in the module graph pays for a `require.resolve`-style
        // lookup for no benefit. See https://github.com/storybookjs/storybook/issues/33778.
        if (this.mockMap.size === 0) {
          return
        }
        // The plugin also calls back after resolution, when a new request has no effect.
        if (resource.createData?.resource) {
          return
        }
        if (!this.canResolveToMock(resource.request, resource.context)) {
          return
        }

        const path = resource.request
        const importer = resource.context

        const isExternal = getIsExternal(path, importer)
        // Early filter only for external specifiers. Relative/local specifiers still need
        // resolution to compare against the absolute paths stored in `mockMap`.
        if (isExternal && !this.candidateSpecifiers.has(path)) {
          return
        }
        const absolutePath = isExternal
          ? resolveExternalModule(path, importer)
          : resolveWithExtensions(path, importer)

        const normalizedAbsolutePath = normalizePath(absolutePath)

        if (this.mockMap.has(normalizedAbsolutePath)) {
          resource.request = this.mockMap.get(
            normalizedAbsolutePath,
          )!.replacementResource
        }
      } catch {
        logger.debug(`Could not resolve mock for "${resource.request}".`)
      }
    }).apply(compiler)

    compiler.hooks.afterCompile.tap(PLUGIN_NAME, (compilation) => {
      compilation.fileDependencies.add(this.options.previewConfigPath)

      for (const mock of this.mockMap.values()) {
        if (
          isAbsolute(mock.replacementResource) &&
          mock.replacementResource.includes('__mocks__')
        ) {
          compilation.contextDependencies.add(dirname(mock.replacementResource))
        }
      }
    })
  }

  /**
   * A cheap check that runs before `require.resolve`, which throws several times for most
   * requests. Returns false only for requests that cannot resolve to a mocked module: a relative
   * or absolute request resolves at or below the path it joins to, and a bare request reaches a
   * file through the package it names.
   */
  private canResolveToMock(request: string, context: string): boolean {
    if (RELATIVE_REQUEST.test(request) || isAbsolute(request)) {
      // `require.resolve` joins the request to the context and then follows symlinks, unless Node
      // runs with `--preserve-symlinks`, so accept the joined path both as written and with
      // symlinks in its directory followed.
      const path = resolve(context, request)
      return (
        this.mockRequestPaths.has(normalizePath(path)) ||
        this.mockRequestPaths.has(
          normalizePath(
            join(this.getRealDirectory(dirname(path)), basename(path)),
          ),
        )
      )
    }
    return (
      this.candidateSpecifiers.has(request) ||
      this.mockPackageNames.has(getPackageName(request))
    )
  }

  /** The real path of a directory, cached because many requests share a directory. */
  private getRealDirectory(directory: string): string {
    let realDirectory = this.realDirectories.get(directory)
    if (realDirectory === undefined) {
      try {
        realDirectory = realpathSync(directory)
      } catch {
        realDirectory = directory
      }
      this.realDirectories.set(directory, realDirectory)
    }
    return realDirectory
  }

  private getPreviewConfigMtime(compiler: Rspack.Compiler): number | undefined {
    try {
      const fs = compiler.inputFileSystem as any
      const stat = fs.statSync?.(this.options.previewConfigPath)
      return stat?.mtime?.getTime?.()
    } catch {
      return undefined
    }
  }

  private extractAndResolveMocks(compiler: Rspack.Compiler): ResolvedMock[] {
    const { previewConfigPath, configDir } = this.options
    const logger = compiler.getInfrastructureLogger(PLUGIN_NAME)

    const mocks = extractMockCalls(
      {
        previewConfigPath,
        configDir: configDir ?? dirname(previewConfigPath),
      },
      babelParser,
      compiler.context,
      findMockRedirect,
    )

    const resolvedMocks: ResolvedMock[] = []

    for (const mock of mocks) {
      try {
        const { absolutePath, redirectPath } = mock

        let replacementResource: string

        if (redirectPath) {
          replacementResource = redirectPath
        } else {
          const loaderPath = fileURLToPath(
            import.meta
              .resolve('storybook-builder-rsbuild/loaders/rsbuild-automock-loader'),
          )
          replacementResource = `${loaderPath}?spy=${mock.spy}!${absolutePath}`
        }

        resolvedMocks.push({
          ...mock,
          replacementResource,
        })
      } catch (_error) {
        logger.warn(
          `Could not resolve mock for "${mock.path}". It will be ignored.`,
        )
      }
    }

    return resolvedMocks
  }
}
