import { createBroker } from './index';
import { ConfigError, loadConfig } from './config';

try {
  const config = loadConfig();
  const broker = createBroker({ config });
  const port = await broker.listen();
  console.log(`token-broker listening on :${port}`);
  console.log(`providers: ${Object.keys(config.providers).join(', ')}`);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`configuration error: ${error.message}`);
  } else {
    console.error('broker failed to start');
  }
  process.exit(1);
}
