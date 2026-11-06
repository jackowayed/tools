import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

export async function startBackend() {
  const mf = new Miniflare({ modules: true, scriptPath: new URL('../worker/index.js', import.meta.url).pathname,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-07-01', d1Databases: { SYNC_DB: 'test-sync' } });
  try {
    const db = await mf.getD1Database('SYNC_DB');
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      const schema = await readFile(new URL(file, directory), 'utf8');
      // Preserve trigger bodies as single statements, including later migrations.
      const statements = schema.replace(/^--.*$/gm, '').match(/CREATE TRIGGER[\s\S]*?END;|(?:CREATE (?:TABLE|INDEX)|ALTER TABLE|DROP TRIGGER)[\s\S]*?;/g);
      await db.batch(statements.map(sql => db.prepare(sql)));
    }
    return { mf, db };
  } catch (error) { await mf.dispose(); throw error; }
}
