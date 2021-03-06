/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  BuilderContext,
  BuilderOutput,
  createBuilder,
} from '@angular-devkit/architect';
import { WebpackLoggingCallback, runWebpack } from '@angular-devkit/build-webpack';
import {
  experimental,
  json,
  logging,
  normalize,
  resolve,
  virtualFs,
} from '@angular-devkit/core';
import { NodeJsSyncHost } from '@angular-devkit/core/node';
import * as fs from 'fs';
import * as path from 'path';
import { Observable, combineLatest, from, of } from 'rxjs';
import { concatMap, map, switchMap } from 'rxjs/operators';
import * as webpack from 'webpack';
import { NgBuildAnalyticsPlugin } from '../../plugins/webpack/analytics';
import { WebpackConfigOptions } from '../angular-cli-files/models/build-options';
import {
  getAotConfig,
  getBrowserConfig,
  getCommonConfig,
  getNonAotConfig,
  getStatsConfig,
  getStylesConfig,
  getWorkerConfig,
} from '../angular-cli-files/models/webpack-configs';
import { augmentAppWithServiceWorker } from '../angular-cli-files/utilities/service-worker';
import {
  statsErrorsToString,
  statsToString,
  statsWarningsToString,
} from '../angular-cli-files/utilities/stats';
import { deleteOutputDir } from '../utils';
import { generateBrowserWebpackConfigFromContext } from '../utils/webpack-browser-config';
import { Schema as BrowserBuilderSchema } from './schema';

export type BrowserBuilderOutput = json.JsonObject & BuilderOutput & {
  outputPath: string;
};

export function createBrowserLoggingCallback(
  verbose: boolean,
  logger: logging.LoggerApi,
): WebpackLoggingCallback {
  return (stats, config) => {
    // config.stats contains our own stats settings, added during buildWebpackConfig().
    const json = stats.toJson(config.stats);
    if (verbose) {
      logger.info(stats.toString(config.stats));
    } else {
      logger.info(statsToString(json, config.stats));
    }

    if (stats.hasWarnings()) {
      logger.warn(statsWarningsToString(json, config.stats));
    }
    if (stats.hasErrors()) {
      logger.error(statsErrorsToString(json, config.stats));
    }
  };
}

export async function buildBrowserWebpackConfigFromContext(
  options: BrowserBuilderSchema,
  context: BuilderContext,
  host: virtualFs.Host<fs.Stats>,
): Promise<{ workspace: experimental.workspace.Workspace, config: webpack.Configuration[] }> {
  return generateBrowserWebpackConfigFromContext(
    options,
    context,
    wco => [
      getCommonConfig(wco),
      getBrowserConfig(wco),
      getStylesConfig(wco),
      getStatsConfig(wco),
      getAnalyticsConfig(wco, context),
      getCompilerConfig(wco),
      wco.buildOptions.webWorkerTsConfig ? getWorkerConfig(wco) : {},
    ],
    host,
  );
}

function getAnalyticsConfig(
  wco: WebpackConfigOptions,
  context: BuilderContext,
): webpack.Configuration {
  if (context.analytics) {
    // If there's analytics, add our plugin. Otherwise no need to slow down the build.
    let category = 'build';
    if (context.builder) {
      // We already vetted that this is a "safe" package, otherwise the analytics would be noop.
      category = context.builder.builderName.split(':')[1];
    }

    // The category is the builder name if it's an angular builder.
    return {
      plugins: [
        new NgBuildAnalyticsPlugin(wco.projectRoot, context.analytics, category),
      ],
    };
  }

  return {};
}

function getCompilerConfig(wco: WebpackConfigOptions): webpack.Configuration {
  if (wco.buildOptions.main || wco.buildOptions.polyfills) {
    return wco.buildOptions.aot ? getAotConfig(wco) : getNonAotConfig(wco);
  }

  return {};
}

export type BrowserConfigTransformFn = (
  workspace: experimental.workspace.Workspace,
  config: webpack.Configuration,
) => Observable<webpack.Configuration>;


export function buildWebpackBrowser(
  options: BrowserBuilderSchema,
  context: BuilderContext,
  transforms: {
    config?: BrowserConfigTransformFn,
    output?: (output: BrowserBuilderOutput) => Observable<BuilderOutput>,
    logging?: WebpackLoggingCallback,
  } = {},
) {
  const host = new NodeJsSyncHost();
  const root = normalize(context.workspaceRoot);

  const configFn = transforms.config;
  const outputFn = transforms.output;
  const loggingFn = transforms.logging
    || createBrowserLoggingCallback(!!options.verbose, context.logger);

  // This makes a host observable into a cold one. This is because we want to wait until
  // subscription before calling buildBrowserWebpackConfigFromContext, which can throw.
  return of(null).pipe(
    switchMap(() => from(buildBrowserWebpackConfigFromContext(options, context, host))),
    switchMap(({ workspace, config }) => {
      if (configFn) {
        return combineLatest(config.map(config => configFn(workspace, config))).pipe(
          map(config => ({ workspace, config })),
        );
      } else {
        return of({ workspace, config });
      }
    }),
    switchMap(({ workspace, config }) => {
      if (options.deleteOutputPath) {
        return deleteOutputDir(
          normalize(context.workspaceRoot),
          normalize(options.outputPath),
          host,
        ).pipe(map(() => ({ workspace, config })));
      } else {
        return of({ workspace, config });
      }
    }),
    switchMap(({ workspace, config: configs }) => {
      const projectName = context.target
        ? context.target.project : workspace.getDefaultProjectName();

      if (!projectName) {
        throw new Error('Must either have a target from the context or a default project.');
      }

      const projectRoot = resolve(
        workspace.root,
        normalize(workspace.getProject(projectName).root),
      );

      return combineLatest(
        configs.map(config => runWebpack(config, context, { logging: loggingFn })),
      )
      .pipe(
        switchMap(buildEvents => {
          if (buildEvents.length === 2) {
            // todo implement writing index.html for differential loading in another PR
          }

          return of(buildEvents);
        }),
        map(buildEvents => ({ success: buildEvents.every(r => r.success) })),
        concatMap(buildEvent => {
          if (buildEvent.success && !options.watch && options.serviceWorker) {
            return from(augmentAppWithServiceWorker(
              host,
              root,
              projectRoot,
              resolve(root, normalize(options.outputPath)),
              options.baseHref || '/',
              options.ngswConfigPath,
            ).then(() => ({ success: true }), () => ({ success: false })));
          } else {
            return of(buildEvent);
          }
        }),
        map(event => ({
          ...event,
          // If we use differential loading, both configs have the same outputs
          outputPath: path.resolve(context.workspaceRoot, options.outputPath),
        } as BrowserBuilderOutput)),
        concatMap(output => outputFn ? outputFn(output) : of(output)),
      );
    }),
  );
}


export default createBuilder<json.JsonObject & BrowserBuilderSchema>(buildWebpackBrowser);
