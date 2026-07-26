import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { loadAndMergeExistingMediaIndex } from '../src/media.mjs';

const config = loadConfig();
const records = await loadAndMergeExistingMediaIndex(config.archiveRoot);
const indexPath = path.join(config.archiveRoot, 'existing-media.jsonl');
const content = records.map((record) => JSON.stringify(record)).join('\n');
await fs.writeFile(indexPath, content ? `${content}\n` : '', 'utf8');
console.log(`已索引 ${records.length} 张现有图片：${indexPath}`);
