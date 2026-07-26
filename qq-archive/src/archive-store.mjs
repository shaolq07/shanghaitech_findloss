import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createExistingMediaLookup,
  downloadImage,
  findExistingMedia,
  loadAndMergeExistingMediaIndex
} from './media.mjs';
import { normalizeOneBotEvent } from './normalize.mjs';

function portablePath(value) {
  return value.split(path.sep).join('/');
}

function groupFileName(groupId) {
  return `group-${String(groupId).replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`;
}

async function readJsonLines(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export class ArchiveStore {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.fetchImage = dependencies.downloadImage || downloadImage;
    this.seenMessageIds = new Set();
    this.existingMedia = [];
    this.existingMediaLookup = new Map();
    this.queue = Promise.resolve();
  }

  async init() {
    this.exportsDirectory = path.join(this.config.archiveRoot, 'exports');
    await fs.mkdir(this.exportsDirectory, { recursive: true });
    await fs.mkdir(path.join(this.config.archiveRoot, 'archive-media'), { recursive: true });

    this.existingMedia = await loadAndMergeExistingMediaIndex(this.config.archiveRoot);
    this.existingMediaLookup = createExistingMediaLookup(this.existingMedia);
    await this.writeExistingMediaIndex();

    const exportFiles = await fs.readdir(this.exportsDirectory, { withFileTypes: true });
    for (const entry of exportFiles) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const records = await readJsonLines(path.join(this.exportsDirectory, entry.name));
      for (const record of records) {
        if (record.group_id && record.message_id) {
          this.seenMessageIds.add(`${record.group_id}:${record.message_id}`);
        }
      }
    }
  }

  async writeExistingMediaIndex() {
    const indexPath = path.join(this.config.archiveRoot, 'existing-media.jsonl');
    const content = this.existingMedia.map((record) => JSON.stringify(record)).join('\n');
    await fs.writeFile(indexPath, content ? `${content}\n` : '', 'utf8');
  }

  ingest(payload) {
    const operation = this.queue.then(() => this.#ingest(payload));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async #ingest(payload) {
    const normalized = normalizeOneBotEvent(payload);
    if (normalized.ignored) return normalized;

    if (
      this.config.allowedGroupIds.size > 0
      && !this.config.allowedGroupIds.has(normalized.group_id)
    ) {
      return { ignored: true, reason: '群号不在 QQ_ARCHIVE_GROUP_IDS 白名单中' };
    }

    const uniqueId = `${normalized.group_id}:${normalized.message_id}`;
    if (this.seenMessageIds.has(uniqueId)) {
      return { ignored: true, reason: '重复消息', duplicate: true };
    }

    const images = [];
    let existingMediaChanged = false;
    for (const segment of normalized.image_segments) {
      const data = segment.data || {};
      const existing = findExistingMedia(data, this.existingMediaLookup);
      if (existing) {
        images.push({
          original_file: data.file || data.name || '',
          relative_path: existing.relative_path,
          source: 'existing',
          bytes: existing.bytes,
          sha256: existing.sha256
        });
        const link = {
          group_id: normalized.group_id,
          message_id: normalized.message_id,
          time: normalized.time
        };
        existing.message_links ||= [];
        if (!existing.message_links.some((entry) => (
          entry.group_id === link.group_id && entry.message_id === link.message_id
        ))) {
          existing.message_links.push(link);
          existing.linked_group_id ||= link.group_id;
          existing.linked_message_id ||= link.message_id;
          if (existing.lost_found_type === 'unknown' && normalized.lost_found.type !== 'unknown') {
            existing.lost_found_type = normalized.lost_found.type;
          }
          existingMediaChanged = true;
        }
        continue;
      }

      if (!data.url) {
        images.push({
          original_file: data.file || data.name || '',
          relative_path: '',
          source: 'unavailable',
          error: '事件中没有可下载的 HTTPS URL'
        });
        continue;
      }

      try {
        images.push(await this.fetchImage({
          url: data.url,
          archiveRoot: this.config.archiveRoot,
          groupId: normalized.group_id,
          messageId: normalized.message_id,
          index: segment.index,
          originalFile: data.file || data.name || '',
          maxBytes: this.config.maxImageBytes,
          timeoutMs: this.config.imageTimeoutMs
        }));
      } catch (error) {
        images.push({
          original_file: data.file || data.name || '',
          relative_path: '',
          source: 'download_failed',
          error: error.message
        });
      }
    }

    const record = {
      schema_version: 1,
      platform: 'qq',
      source: 'onebot11',
      group_id: normalized.group_id,
      message_id: normalized.message_id,
      time: normalized.time,
      sender_id: normalized.sender_id,
      sender_name: normalized.sender_name,
      message_type: normalized.message_type,
      content: normalized.content,
      lost_found: normalized.lost_found,
      images,
      segments: normalized.segments,
      received_at: new Date().toISOString()
    };

    const destination = path.join(this.exportsDirectory, groupFileName(record.group_id));
    await fs.appendFile(destination, `${JSON.stringify(record)}\n`, 'utf8');
    if (existingMediaChanged) await this.writeExistingMediaIndex();
    this.seenMessageIds.add(uniqueId);
    return {
      ignored: false,
      archived: true,
      group_id: record.group_id,
      message_id: record.message_id,
      export_file: portablePath(path.relative(this.config.archiveRoot, destination)),
      image_count: images.length,
      record
    };
  }

  async query({ groupId = '', limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));
    const files = groupId
      ? [groupFileName(groupId)]
      : (await fs.readdir(this.exportsDirectory)).filter((name) => name.endsWith('.jsonl'));
    const messages = [];
    for (const fileName of files) {
      const records = await readJsonLines(path.join(this.exportsDirectory, fileName));
      messages.push(...records);
    }
    return messages
      .sort((left, right) => String(right.time).localeCompare(String(left.time)))
      .slice(0, boundedLimit);
  }
}
