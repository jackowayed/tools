import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

export async function startBackend() {
  const mf = new Miniflare({ modules: true, scriptPath: new URL('../worker/index.js', import.meta.url).pathname,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-07-01', d1Databases: { SYNC_DB: 'test-sync' } });
  try {
    const db = await mf.getD1Database('SYNC_DB');
    const schema = await readFile(new URL('../migrations/0001_baby_weight_sync.sql', import.meta.url), 'utf8');
    // Preserve trigger bodies as single SQL statements.
    const statements = schema.replace(/^--.*$/gm, '').match(/CREATE TRIGGER[\s\S]*?END;|CREATE (?:TABLE|INDEX)[\s\S]*?;/g);
    await db.batch(statements.map(sql => db.prepare(sql)));
    return { mf, db };
  } catch (error) { await mf.dispose(); throw error; }
}
