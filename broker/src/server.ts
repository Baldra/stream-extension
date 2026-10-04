import { createBroker } from './index';
import { ConfigError, loadConfig } from './config';
import { createLogger } from './logging';

const logger = createLogger('server');

try {
  const config = loadConfig();
  const broker = createBroker({ config });
  const port = await broker.listen();
  logger.info(`token-broker listening on :${port}`);
  logger.info(`providers: ${Object.keys(config.providers).join(', ')}`);
} catch (error) {
  if (error instanceof ConfigError) {
    logger.error(`configuration error: ${error.message}`);
  } else {
    logger.error('broker failed to start');
  }
  process.exit(1);
}
