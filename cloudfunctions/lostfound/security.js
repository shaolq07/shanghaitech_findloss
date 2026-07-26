'use strict';

const MAX_IMAGE_BASE64_LENGTH = 7 * 1024 * 1024;
const MAX_IMAGE_URL_LENGTH = 4096;
const MAX_HINT_LENGTH = 500;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PRIVATE_FIELDS = new Set([
  '_openid',
  'ownerOpenid',
  'authorOpenid',
  'userOpenid',
  'actorOpenid',
  'reporterOpenid',
  'fromOpenid',
  'toOpenid',
  'imageEmbedding',
  'semanticEmbedding'
]);

function resolveCallerId(wxContext = {}, runtimeContext = {}) {
  return String(
    wxContext.OPENID
      || runtimeContext?.auth?.openId
      || runtimeContext?.auth?.openid
      || runtimeContext?.auth?.uid
      || runtimeContext?.auth?.userId
      || ''
  ).trim();
}

function validateVisionInput(event = {}) {
  const hint = String(event.hint || '');
  if (hint.length > MAX_HINT_LENGTH) {
    return { ok: false, code: 'HINT_TOO_LONG', message: `补充描述不能超过 ${MAX_HINT_LENGTH} 个字符` };
  }

  if (event.imageBase64) {
    const imageBase64 = String(event.imageBase64);
    const mimeType = String(event.mimeType || event.contentType || 'image/jpeg').toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return { ok: false, code: 'UNSUPPORTED_IMAGE_TYPE', message: '仅支持 JPEG、PNG 或 WebP 图片' };
    }
    if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
      return { ok: false, code: 'IMAGE_TOO_LARGE', message: '图片过大，请压缩到 5MB 以内后重试' };
    }
  }

  if (event.imageUrl) {
    const imageUrl = String(event.imageUrl).trim();
    if (imageUrl.length > MAX_IMAGE_URL_LENGTH || !/^https:\/\//i.test(imageUrl)) {
      return { ok: false, code: 'INVALID_IMAGE_URL', message: '图片地址必须是有效的 HTTPS 链接' };
    }
  }

  return { ok: true };
}

function createRateLimiter({ limit = 8, windowMs = 60_000 } = {}) {
  const buckets = new Map();
  return {
    check(key, now = Date.now()) {
      const safeKey = String(key || '').trim();
      if (!safeKey) return { allowed: false, retryAfterMs: windowMs };
      const recent = (buckets.get(safeKey) || []).filter((timestamp) => now - timestamp < windowMs);
      if (recent.length >= limit) {
        return { allowed: false, retryAfterMs: Math.max(1, windowMs - (now - recent[0])) };
      }
      recent.push(now);
      buckets.set(safeKey, recent);
      if (buckets.size > 2000) {
        for (const [bucketKey, timestamps] of buckets) {
          if (!timestamps.some((timestamp) => now - timestamp < windowMs)) buckets.delete(bucketKey);
        }
      }
      return { allowed: true, remaining: limit - recent.length };
    }
  };
}

function toPublicRecord(record, callerId = '') {
  if (!record || typeof record !== 'object') return record;
  const ownerId = record.ownerOpenid || record.authorOpenid || record._openid || '';
  const sanitized = {};
  Object.entries(record).forEach(([key, value]) => {
    if (!PRIVATE_FIELDS.has(key)) sanitized[key] = value;
  });
  if (ownerId && callerId) sanitized.isMine = ownerId === callerId;
  return sanitized;
}

module.exports = {
  MAX_IMAGE_BASE64_LENGTH,
  createRateLimiter,
  resolveCallerId,
  toPublicRecord,
  validateVisionInput
};
