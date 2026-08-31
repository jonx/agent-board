// Reads CHANGELOG.md ("## x.y.z" sections, newest first) and returns the entries newer than a given version.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

export function changelogSince(version, file = join(ROOT, 'CHANGELOG.md')) {
  let text; try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  const out = [];
  for (const section of text.split(/^## /m).slice(1)) {
    const v = section.split(/\s/)[0];
    if (v === version) break;
    out.push('## ' + section.trim());
  }
  return out.join('\n\n').trim();
}
