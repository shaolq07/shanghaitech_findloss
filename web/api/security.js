const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:5174'];
const MAX_IMAGE_BASE64_LENGTH = 7 * 1024 * 1024;
const MAX_IMAGE_URL_LENGTH = 4096;
const MAX_HINT_LENGTH = 500;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function getAllowedOrigins(value = '') {
  const configured = String(value)
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

export function applyCors(req, res, configuredOrigins = '') {
  const origin = String(req.headers?.origin || '').replace(/\/$/, '');
  const allowedOrigins = getAllowedOrigins(configuredOrigins);
  if (origin && !allowedOrigins.includes(origin)) return false;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return true;
}

export function getClientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

export function validateVisionBody(body = {}) {
  const hint = String(body.hint || '');
  if (hint.length > MAX_HINT_LENGTH) {
    return { ok: false, status: 400, code: 'HINT_TOO_LONG', message: `补充描述不能超过 ${MAX_HINT_LENGTH} 个字符` };
  }
  if (body.imageBase64) {
    const imageBase64 = String(body.imageBase64);
    const mimeType = String(body.mimeType || 'image/jpeg').toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return { ok: false, status: 415, code: 'UNSUPPORTED_IMAGE_TYPE', message: '仅支持 JPEG、PNG 或 WebP 图片' };
    }
    if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
      return { ok: false, status: 413, code: 'IMAGE_TOO_LARGE', message: '图片过大，请压缩到 5MB 以内后重试' };
    }
  }
  if (body.imageUrl) {
    const imageUrl = String(body.imageUrl).trim();
    if (imageUrl.length > MAX_IMAGE_URL_LENGTH || !/^https:\/\//i.test(imageUrl)) {
      return { ok: false, status: 400, code: 'INVALID_IMAGE_URL', message: '图片地址必须是有效的 HTTPS 链接' };
    }
  }
  if (!body.imageBase64 && !body.imageUrl) {
    return { ok: false, status: 400, code: 'IMAGE_REQUIRED', message: '缺少 imageBase64 或 imageUrl' };
  }
  return { ok: true };
}

export function createRateLimiter({ limit = 8, windowMs = 60_000 } = {}) {
  const buckets = new Map();
  return {
    check(key, now = Date.now()) {
      const recent = (buckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
      if (recent.length >= limit) return { allowed: false, retryAfterMs: Math.max(1, windowMs - (now - recent[0])) };
      recent.push(now);
      buckets.set(key, recent);
      return { allowed: true, remaining: limit - recent.length };
    }
  };
}
