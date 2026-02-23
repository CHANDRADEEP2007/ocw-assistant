import fs from 'node:fs';
import path from 'node:path';

import { sqlite } from './client.js';

export function runMigrations() {
  const migrationsDir = path.resolve(process.cwd(), 'drizzle');
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sqlite.exec(sql);
    console.log(`applied ${file}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
}
