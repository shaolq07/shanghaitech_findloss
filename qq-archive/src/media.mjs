import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const CONTENT_TYPE_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp']
]);

function portablePath(value) {
  return value.split(path.sep).join('/');
}

function safeFilePart(value, fallback = 'unknown') {
  const sanitized = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return sanitized || fallback;
}

export async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function indexExistingMedia(archiveRoot) {
  await fs.mkdir(archiveRoot, { recursive: true });
  const entries = await fs.readdir(archiveRoot, { withFileTypes: true });
  const records = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;
    const absolutePath = path.join(archiveRoot, entry.name);
    const stat = await fs.stat(absolutePath);
    records.push({
      file_name: entry.name,
      relative_path: portablePath(path.relative(archiveRoot, absolutePath)),
      extension,
      bytes: stat.size,
      sha256: await sha256File(absolutePath),
      linked_group_id: null,
      linked_message_id: null,
      lost_found_type: 'unknown',
      message_links: []
    });
  }

  records.sort((left, right) => left.file_name.localeCompare(right.file_name));
  return records;
}

export async function loadAndMergeExistingMediaIndex(archiveRoot) {
  const scanned = await indexExistingMedia(archiveRoot);
  const indexPath = path.join(archiveRoot, 'existing-media.jsonl');
  let previous = [];
  try {
    previous = (await fs.readFile(indexPath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  const previousByHash = new Map(previous.map((record) => [record.sha256, record]));
  return scanned.map((record) => {
    const saved = previousByHash.get(record.sha256);
    if (!saved) return record;
    return {
      ...saved,
      ...record,
      linked_group_id: saved.linked_group_id || null,
      linked_message_id: saved.linked_message_id || null,
      lost_found_type: saved.lost_found_type || 'unknown',
      message_links: Array.isArray(saved.message_links) ? saved.message_links : []
    };
  });
}

export function createExistingMediaLookup(records) {
  const lookup = new Map();
  for (const record of records) {
    const lowerName = record.file_name.toLowerCase();
    lookup.set(lowerName, record);
    lookup.set(path.parse(lowerName).name, record);
  }
  return lookup;
}

export function findExistingMedia(imageData, lookup) {
  const candidates = [
    imageData?.file,
    imageData?.file_id,
    imageData?.name
  ].filter(Boolean);

  for (const candidate of candidates) {
    const baseName = path.basename(String(candidate)).toLowerCase();
    const matched = lookup.get(baseName) || lookup.get(path.parse(baseName).name);
    if (matched) return matched;
  }
  return null;
}

async function readResponseWithLimit(response, maxBytes) {
  const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (contentLength > maxBytes) throw new Error(`图片超过 ${maxBytes} 字节限制`);
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`图片超过 ${maxBytes} 字节限制`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function downloadImage({
  url,
  archiveRoot,
  groupId,
  messageId,
  index,
  originalFile,
  maxBytes,
  timeoutMs
}) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('只下载 HTTPS 图片');
  }

  const response = await fetch(parsedUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'LockMyItem-QQ-Archive/0.1' }
  });
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);

  const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!CONTENT_TYPE_EXTENSIONS.has(contentType)) {
    throw new Error(`不支持的图片类型：${contentType || 'unknown'}`);
  }

  const buffer = await readResponseWithLimit(response, maxBytes);
  const extension = CONTENT_TYPE_EXTENSIONS.get(contentType);
  const datePart = new Date().toISOString().slice(0, 10);
  const relativeDirectory = path.join('archive-media', safeFilePart(groupId), datePart);
  const baseName = `${safeFilePart(messageId)}-${index + 1}${extension}`;
  const relativePath = path.join(relativeDirectory, baseName);
  const absolutePath = path.join(archiveRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  try {
    await fs.writeFile(absolutePath, buffer, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  return {
    original_file: originalFile || '',
    relative_path: portablePath(relativePath),
    source: 'downloaded',
    bytes: buffer.byteLength,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}
