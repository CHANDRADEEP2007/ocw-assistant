import fs from 'node:fs';
import path from 'node:path';

import { sqlite } from './client.js';

export function runMigrations() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _ocw_schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const migrationsDir = path.resolve(process.cwd(), 'drizzle');
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const appliedRows = sqlite.prepare('SELECT id FROM _ocw_schema_migrations').all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const tx = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare('INSERT INTO _ocw_schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    });
    tx();
    console.log(`applied ${file}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
}
