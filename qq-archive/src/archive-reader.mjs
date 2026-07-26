import fs from 'node:fs/promises';
import path from 'node:path';

function safeGroupId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
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
        // 正在追加的最后一行可能尚未完整，查询时跳过即可。
        return null;
      }
    })
    .filter(Boolean);
}

function withinTimeRange(message, since, until) {
  const timestamp = Date.parse(message.time);
  if (!Number.isFinite(timestamp)) return !since && !until;
  if (since && timestamp < Date.parse(since)) return false;
  if (until && timestamp > Date.parse(until)) return false;
  return true;
}

export class ArchiveReader {
  constructor(archiveRoot) {
    this.archiveRoot = path.resolve(archiveRoot);
    this.exportsDirectory = path.join(this.archiveRoot, 'exports');
  }

  async #exportFiles(groupId = '') {
    if (groupId) return [`group-${safeGroupId(groupId)}.jsonl`];
    try {
      return (await fs.readdir(this.exportsDirectory))
        .filter((name) => /^group-.+\.jsonl$/i.test(name))
        .sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async #allMessages(groupId = '') {
    const messages = [];
    for (const fileName of await this.#exportFiles(groupId)) {
      messages.push(...await readJsonLines(path.join(this.exportsDirectory, fileName)));
    }
    return messages;
  }

  async listGroups() {
    const groups = [];
    for (const fileName of await this.#exportFiles()) {
      const messages = await readJsonLines(path.join(this.exportsDirectory, fileName));
      if (!messages.length) continue;
      const sorted = messages.toSorted((left, right) => String(left.time).localeCompare(String(right.time)));
      groups.push({
        group_id: String(messages[0].group_id),
        message_count: messages.length,
        first_message_time: sorted[0]?.time || null,
        last_message_time: sorted.at(-1)?.time || null,
        image_message_count: messages.filter((message) => message.images?.length).length
      });
    }
    return groups.toSorted((left, right) => right.last_message_time.localeCompare(left.last_message_time));
  }

  async searchMessages({
    group_id = '',
    sender_id = '',
    lost_found_type = '',
    query = '',
    since = '',
    until = '',
    limit = 100
  } = {}) {
    const normalizedQuery = String(query).trim().toLowerCase();
    const boundedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));
    return (await this.#allMessages(group_id))
      .filter((message) => !sender_id || String(message.sender_id) === String(sender_id))
      .filter((message) => (
        !lost_found_type || message.lost_found?.type === lost_found_type
      ))
      .filter((message) => (
        !normalizedQuery
        || [
          message.content,
          message.sender_name,
          message.message_id,
          ...(message.images || []).map((image) => image.original_file)
        ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery)
      ))
      .filter((message) => withinTimeRange(message, since, until))
      .toSorted((left, right) => String(right.time).localeCompare(String(left.time)))
      .slice(0, boundedLimit);
  }

  async getMessage(groupId, messageId) {
    const messages = await this.#allMessages(groupId);
    return messages.find((message) => String(message.message_id) === String(messageId)) || null;
  }

  async listMedia({ only_unlinked = false } = {}) {
    const indexRecords = await readJsonLines(path.join(this.archiveRoot, 'existing-media.jsonl'));
    let catalog = { items: [] };
    try {
      catalog = JSON.parse(await fs.readFile(path.join(this.archiveRoot, 'media-catalog.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const catalogByFile = new Map();
    for (const item of catalog.items || []) {
      for (const fileName of item.files || []) catalogByFile.set(fileName, item);
    }

    return indexRecords
      .filter((record) => !only_unlinked || !(record.message_links || []).length)
      .map((record) => {
        const item = catalogByFile.get(record.file_name);
        return {
          ...record,
          catalog_id: item?.catalog_id || null,
          title: item?.title || null,
          category: item?.category || null,
          privacy: item?.privacy || null,
          web_publish_allowed: item?.web_publish_allowed ?? null
        };
      });
  }
}
