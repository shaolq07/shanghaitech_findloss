import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_UPLOAD_CHUNK_BYTES = 48 * 1024;

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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
    this.metrics.queued = (await fs.readdir(this.outboxDirectory))
      .filter((name) => name.endsWith('.json'))
      .length;
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
    try {
      await fs.writeFile(
        destination,
        JSON.stringify({ record, queuedAt: new Date().toISOString() }),
        { encoding: 'utf8', flag: 'wx' }
      );
      this.metrics.queued += 1;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    this.flush().catch(() => undefined);
    return { queued: true };
  }

  async request(payload) {
    const response = await this.fetch(this.config.cloudIngestUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.cloudIngestToken}`,
        'content-type': 'application/json',
        'user-agent': 'lockmyitem-qq-archive/0.3'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.cloudTimeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    const envelope = body?.result || body;
    if (!response.ok || envelope?.ok !== true) {
      throw new Error(
        envelope?.message
        || body?.message
        || `${envelope?.code || 'CLOUD_ERROR'} (${response.status})`
      );
    }
    return envelope.data || {};
  }

  async uploadMedia(record) {
    const mediaRefs = [];
    const configuredChunkBytes = Number(this.config.cloudUploadChunkBytes);
    const chunkBytes = Number.isFinite(configuredChunkBytes) && configuredChunkBytes > 0
      ? Math.min(configuredChunkBytes, 64 * 1024)
      : DEFAULT_UPLOAD_CHUNK_BYTES;

    for (const [mediaIndex, image] of (record.images || []).slice(0, 4).entries()) {
      if (!image.relative_path) continue;
      const absolutePath = resolveArchiveFile(this.config.archiveRoot, image.relative_path);
      const file = await fs.readFile(absolutePath);
      if (file.length > this.config.cloudMaxImageBytes) {
        throw new Error(`图片超过云端转发限制：${image.original_file || image.relative_path}`);
      }
      const digest = sha256(file);
      if (image.sha256 && image.sha256.toLowerCase() !== digest) {
        throw new Error(`图片校验失败：${image.original_file || image.relative_path}`);
      }
      const metadata = {
        groupId: String(record.group_id),
        messageId: String(record.message_id),
        mediaIndex,
        originalFile: image.original_file || path.basename(absolutePath),
        contentType: contentTypeFor(absolutePath),
        bytes: file.length,
        sha256: digest
      };
      const chunkCount = Math.ceil(file.length / chunkBytes);
      const parts = [];
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const start = chunkIndex * chunkBytes;
        const chunk = file.subarray(start, Math.min(start + chunkBytes, file.length));
        const uploaded = await this.request({
          action: 'uploadQQMediaChunk',
          ...metadata,
          chunkIndex,
          chunkCount,
          chunkBase64: chunk.toString('base64')
        });
        if (!uploaded.fileId) throw new Error('Cloud media chunk upload returned no fileId');
        parts.push({ index: chunkIndex, fileId: uploaded.fileId });
      }
      const completed = await this.request({
        action: 'completeQQMediaUpload',
        ...metadata,
        chunkCount,
        parts
      });
      if (!completed.media?.fileId) {
        throw new Error('Cloud media upload completion returned no controlled file reference');
      }
      mediaRefs.push(completed.media);
    }
    return mediaRefs;
  }

  async send(job) {
    const mediaRefs = await this.uploadMedia(job.record);
    return this.request({
      action: 'ingestQQMessage',
      record: job.record,
      mediaRefs
    });
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
    let lastFailure = null;
    for (const fileName of files) {
      const filePath = path.join(this.outboxDirectory, fileName);
      try {
        const job = JSON.parse(await fs.readFile(filePath, 'utf8'));
        await this.send(job);
        await fs.unlink(filePath);
        sent += 1;
        this.metrics.sent += 1;
        this.metrics.queued = Math.max(0, this.metrics.queued - 1);
        this.metrics.last_sent_at = new Date().toISOString();
      } catch (error) {
        this.metrics.failed += 1;
        lastFailure = error;
      }
    }
    this.metrics.last_error = lastFailure?.message || '';
    return { sent, failed: Boolean(lastFailure), queued: this.metrics.queued };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export { resolveArchiveFile };
