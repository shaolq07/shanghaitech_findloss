import {
  applyCors,
  createRateLimiter,
  getClientIp,
  validateVisionBody
} from './security.js';

const HUNYUAN_BASE_URL = (process.env.HUNYUAN_BASE_URL || 'https://api.hunyuan.cloud.tencent.com/v1').replace(/\/$/, '');
const HUNYUAN_MODEL = process.env.HUNYUAN_MODEL || 'hunyuan-vision';
const rateLimiter = createRateLimiter({
  limit: Number(process.env.VISION_RATE_LIMIT || 8),
  windowMs: Number(process.env.VISION_RATE_WINDOW_MS || 60_000)
});

function ok(res, data) {
  return res.status(200).json({ ok: true, data });
}

function fail(res, status, message, code = 'ERROR') {
  return res.status(status).json({ ok: false, code, message });
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function normalizeImageBase64(imageBase64 = '', mimeType = 'image/jpeg') {
  const value = String(imageBase64 || '').trim();
  if (!value) return '';
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value)) return value;
  return `data:${mimeType || 'image/jpeg'};base64,${value.replace(/^data:[^,]+,/, '')}`;
}

function parseJsonContent(content = '') {
  const source = String(content || '').trim();
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch {
    const match = source.match(/\{[\s\S]*\}/);
    if (!match) return {};
    return JSON.parse(match[0]);
  }
}

function normalizeHunyuanResult(result = {}) {
  return {
    title: result.title || result.name || '',
    description: result.description || result.caption || result.visualDescription || '',
    category: result.category || '',
    aiTags: unique(result.aiTags || result.tags || result.keywords || []),
    yoloObjects: unique(result.yoloObjects || result.objects || []),
    semanticTags: unique(result.semanticTags || result.tags || []),
    colors: unique(result.colors || []),
    accessories: unique(result.accessories || []),
    imageEmbedding: result.imageEmbedding || result.image_embedding || [],
    semanticEmbedding: result.semanticEmbedding || result.semantic_embedding || result.embedding || []
  };
}

function buildVisionPrompt(hint = '') {
  return [
    '你是上海科技大学校园失物招领系统的图像识别助手。',
    '请结合图片和用户补充描述，提取可用于失物匹配的结构化标签。',
    '只提取物品信息，不要提到评论区、联系失主、领取流程或发布建议。',
    '必须只返回 JSON，不要 Markdown，不要解释。',
    'JSON 字段：title, description, category, tags, colors, accessories, objects。',
    'category 从以下中文类别中选择：证件、电子产品、书本资料、衣物、钥匙、校园卡、雨伞、水杯、其他。',
    'title/description/tags/colors/accessories/objects 必须使用简体中文。',
    `用户补充描述：${hint || '无'}`
  ].join('\n');
}

export default async function handler(req, res) {
  if (!applyCors(req, res, process.env.ALLOWED_ORIGIN || '')) {
    return fail(res, 403, '请求来源不在允许列表中', 'ORIGIN_NOT_ALLOWED');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return fail(res, 405, 'Method Not Allowed', 'METHOD_NOT_ALLOWED');

  const rate = rateLimiter.check(getClientIp(req));
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
    return fail(res, 429, 'AI 识别请求过于频繁，请稍后再试', 'RATE_LIMITED');
  }

  const apiKey = process.env.HUNYUAN_API_KEY
    || process.env.TENCENT_HUNYUAN_API_KEY
    || process.env.TENCENTCLOUD_API_KEY
    || process.env.MODEL_API_KEY
    || '';

  if (!apiKey) {
    return fail(res, 500, '服务端未配置 HUNYUAN_API_KEY', 'MODEL_NOT_CONFIGURED');
  }

  const body = req.body || {};
  const validation = validateVisionBody(body);
  if (!validation.ok) return fail(res, validation.status, validation.message, validation.code);
  const imageUrl = body.imageUrl || normalizeImageBase64(body.imageBase64, body.mimeType || 'image/jpeg');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${HUNYUAN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: HUNYUAN_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: buildVisionPrompt(body.hint) }
            ]
          }
        ],
        temperature: 0.2
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error && (data.error.message || data.error.code);
      return fail(res, response.status, `混元识别失败${message ? `：${message}` : ''}`, 'HUNYUAN_FAILED');
    }

    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const semantic = normalizeHunyuanResult(parseJsonContent(content || ''));
    return ok(res, {
      title: semantic.title || semantic.category || '待识别物品',
      description: semantic.description || semantic.aiTags.join('、'),
      category: semantic.category || '其他',
      aiTags: unique([
        ...semantic.aiTags,
        ...semantic.colors,
        ...semantic.accessories,
        ...semantic.yoloObjects
      ]),
      yoloObjects: semantic.yoloObjects,
      semanticTags: semantic.semanticTags,
      visualDescription: semantic.description || semantic.aiTags.join('、'),
      imageEmbedding: semantic.imageEmbedding,
      semanticEmbedding: semantic.semanticEmbedding,
      modelSources: {
        provider: 'tencent-hunyuan-compatible',
        baseUrl: HUNYUAN_BASE_URL,
        model: HUNYUAN_MODEL
      }
    });
  } catch (error) {
    const message = error.name === 'AbortError' ? '混元识别超时' : '混元识别暂时不可用';
    return fail(res, 502, message, 'HUNYUAN_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
