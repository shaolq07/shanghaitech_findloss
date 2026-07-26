import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultArchiveRoot = path.resolve(moduleDirectory, '..', '..', 'QQ聊天记录');

function splitCsv(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const host = env.QQ_ARCHIVE_HOST || '127.0.0.1';
  const webhookToken = env.QQ_ARCHIVE_WEBHOOK_TOKEN || '';
  const cloudIngestUrl = String(env.QQ_CLOUD_INGEST_URL || '').trim();
  const cloudIngestToken = String(env.QQ_CLOUD_INGEST_TOKEN || '').trim();

  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !webhookToken) {
    throw new Error('监听非本机地址时必须设置 QQ_ARCHIVE_WEBHOOK_TOKEN');
  }
  if (cloudIngestUrl && !cloudIngestToken) {
    throw new Error('配置 QQ_CLOUD_INGEST_URL 时必须同时设置 QQ_CLOUD_INGEST_TOKEN');
  }
  if (cloudIngestUrl && !/^https:\/\//i.test(cloudIngestUrl)) {
    throw new Error('QQ_CLOUD_INGEST_URL 必须使用 HTTPS');
  }

  return {
    archiveRoot: path.resolve(env.QQ_ARCHIVE_ROOT || defaultArchiveRoot),
    host,
    port: positiveInteger(env.QQ_ARCHIVE_PORT, 8788),
    webhookToken,
    allowedGroupIds: splitCsv(env.QQ_ARCHIVE_GROUP_IDS),
    maxBodyBytes: positiveInteger(env.QQ_ARCHIVE_MAX_BODY_BYTES, 5 * 1024 * 1024),
    maxImageBytes: positiveInteger(env.QQ_ARCHIVE_MAX_IMAGE_BYTES, 12 * 1024 * 1024),
    imageTimeoutMs: positiveInteger(env.QQ_ARCHIVE_IMAGE_TIMEOUT_MS, 15_000),
    cloudIngestUrl,
    cloudIngestToken,
    cloudGroupIds: splitCsv(env.QQ_CLOUD_GROUP_IDS || '731332881'),
    cloudRetryMs: positiveInteger(env.QQ_CLOUD_RETRY_MS, 30_000),
    cloudTimeoutMs: positiveInteger(env.QQ_CLOUD_TIMEOUT_MS, 45_000),
    cloudMaxImageBytes: positiveInteger(env.QQ_CLOUD_MAX_IMAGE_BYTES, 8 * 1024 * 1024)
  };
}
