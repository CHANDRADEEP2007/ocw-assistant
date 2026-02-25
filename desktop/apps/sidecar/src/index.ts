import { config } from './config.js';
import { createApp } from './app.js';

async function boot() {
  const app = createApp();

  app.listen(config.port, () => {
    console.log(`ocw-sidecar listening on http://127.0.0.1:${config.port}`);
  });
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
