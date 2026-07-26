import fs from 'node:fs/promises';
import path from 'node:path';

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  }[extension] || 'image/jpeg';
}

function safeJobName(record) {
  return `${record.group_id}-${record.message_id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function resolveArchiveFile(archiveRoot, relativePath) {
  const root = path.resolve(archiveRoot);
  const candidate = path.resolve(root, String(relativePath || ''));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('图片路径不在归档目录中');
  }
  return candidate;
}

export class CloudForwarder {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.timer = null;
    this.flushPromise = null;
    this.metrics = {
      queued: 0,
      sent: 0,
      failed: 0,
      last_sent_at: null,
      last_error: ''
    };
  }

  async init() {
    this.outboxDirectory = path.join(this.config.archiveRoot, 'cloud-outbox');
    await fs.mkdir(this.outboxDirectory, { recursive: true });
    if (this.enabled) {
      this.timer = setInterval(() => this.flush().catch(() => undefined), this.config.cloudRetryMs);
      this.timer.unref();
      this.flush().catch(() => undefined);
    }
  }

  get enabled() {
    return Boolean(this.config.cloudIngestUrl && this.config.cloudIngestToken);
  }

  getStats() {
    return { enabled: this.enabled, ...this.metrics };
  }

  async enqueue(record) {
    if (!this.enabled || !this.config.cloudGroupIds.has(String(record.group_id))) {
      return { queued: false, reason: this.enabled ? '群号不在云端转发白名单中' : '云端转发未配置' };
    }
    const destination = path.join(this.outboxDirectory, `${safeJobName(record)}.json`);
    await fs.writeFile(destination, JSON.stringify({ record, queuedAt: new Date().toISOString() }), 'utf8');
    this.metrics.queued += 1;
    this.flush().catch(() => undefined);
    return { queued: true };
  }

  async buildMedia(record) {
    const media = [];
    for (const image of (record.images || []).slice(0, 4)) {
      if (!image.relative_path) continue;
      const absolutePath = resolveArchiveFile(this.config.archiveRoot, image.relative_path);
      const file = await fs.readFile(absolutePath);
      if (file.length > this.config.cloudMaxImageBytes) {
        throw new Error(`图片超过云端转发限制：${image.original_file || image.relative_path}`);
      }
      media.push({
        originalFile: image.original_file || path.basename(absolutePath),
        contentType: contentTypeFor(absolutePath),
        bytes: file.length,
        sha256: image.sha256 || '',
        base64: file.toString('base64')
      });
    }
    return media;
  }

  async send(job) {
    const media = await this.buildMedia(job.record);
    const response = await this.fetch(this.config.cloudIngestUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.cloudIngestToken}`,
        'content-type': 'application/json',
        'user-agent': 'lockmyitem-qq-archive/0.2'
      },
      body: JSON.stringify({
        action: 'ingestQQMessage',
        record: job.record,
        media
      }),
      signal: AbortSignal.timeout(this.config.cloudTimeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    const result = body?.data || body?.result?.data || body?.result || body;
    const requestOk = response.ok && (body.ok === true || body?.result?.ok === true);
    if (!requestOk) {
      throw new Error(result?.message || body?.message || `云端接口返回 ${response.status}`);
    }
    return result;
  }

  flush() {
    if (!this.enabled) return Promise.resolve({ sent: 0 });
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.#flush().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  async #flush() {
    const files = (await fs.readdir(this.outboxDirectory))
      .filter((name) => name.endsWith('.json'))
      .sort();
    let sent = 0;
    for (const fileName of files) {
      const filePath = path.join(this.outboxDirectory, fileName);
      try {
        const job = JSON.parse(await fs.readFile(filePath, 'utf8'));
        await this.send(job);
        await fs.unlink(filePath);
        sent += 1;
        this.metrics.sent += 1;
        this.metrics.last_sent_at = new Date().toISOString();
        this.metrics.last_error = '';
      } catch (error) {
        this.metrics.failed += 1;
        this.metrics.last_error = error.message;
        break;
      }
    }
    return { sent };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export { resolveArchiveFile };
