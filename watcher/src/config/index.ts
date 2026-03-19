import { ChainConfigSchema, ExchangeConfigSchema, type AppConfig, type PlatformConfig } from './models.ts';
import * as platforms from './platforms/index.ts';
import { logger } from '../utils';

if (!process.env.APP_CONFIG_ENABLED_PLATFORMS) throw new Error('APP_CONFIG_ENABLED_PLATFORMS env var is not set!');
const enabledPlatforms = process.env.APP_CONFIG_ENABLED_PLATFORMS.split(',').map((s) => s.trim());

export const appConfig: AppConfig = {
  apiServerPort: parseInt(process.env.APP_CONFIG_API_SERVER_PORT ?? '4040', 10),
  logLevel: process.env.APP_CONFIG_LOG_LEVEL ?? 'info',
  enabledPlatforms,
  platforms: loadConfigs(enabledPlatforms),
};

function loadConfigs(enabledPlatforms: string[]): Record<string, PlatformConfig> {
  try {
    const configs: Record<string, PlatformConfig> = {};
    for (const platformName of enabledPlatforms) {
      logger.info(`Loading config for platform: ${platformName}`);
      const platformConfig = (platforms as any)[platformName];
      if (!platformConfig) throw new Error(`Platform "${platformName}" is enabled but no but no config found!`);
      // validate config data with zod
      let parsedConfig: PlatformConfig;
      if (platformConfig.platformType === 'chain') {
        parsedConfig = ChainConfigSchema.parse(platformConfig);
      } else {
        parsedConfig = ExchangeConfigSchema.parse(platformConfig);
      }
      configs[platformName] = parsedConfig;
      logger.info(`✅ Loaded config for platform: ${platformName}`);
    }
    return configs;
  } catch (err) {
    logger.error(`Error loading config: ${(err as Error).message}`);
    process.exit(1);
  }
}
