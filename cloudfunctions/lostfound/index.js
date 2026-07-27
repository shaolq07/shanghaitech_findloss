const cloud = require('wx-server-sdk');
const fetch = require('node-fetch');
const crypto = require('crypto');
const {
  createRateLimiter,
  resolveCallerId,
  toPublicRecord,
  validateVisionInput
} = require('./security');
const {
  QQ_REVIEW_IMAGE_TYPES,
  normalizeIncomingRecord,
  normalizeQQMediaRefs,
  orderQQMediaParts,
  parseCsv,
  reviewId,
  safeEqual,
  sanitizeDraft
} = require('./qq-review');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = {
  users: 'users',
  items: 'items',
  comments: 'comments',
  thanks: 'thanks',
  notifications: 'notifications',
  reports: 'reports',
  locations: 'campus_locations',
  qqReviewQueue: 'qq_review_queue'
};

const CATEGORY_KEYWORDS = {
  '证件': ['证件', '身份证', '学生证', '卡片', '护照'],
  '电子产品': ['手机', '电脑', '耳机', '充电器', '平板', '电子'],
  '书本资料': ['书', '教材', '笔记', '资料', '文件', '纸'],
  '衣物': ['衣服', '外套', '帽子', '围巾', '手套'],
  '钥匙': ['钥匙', '门禁'],
  '校园卡': ['校园卡', '一卡通', '饭卡'],
  '雨伞': ['伞', '雨伞'],
  '水杯': ['杯', '水杯', '保温杯']
};

const BAD_WORDS = ['辱骂', '广告', '诈骗', '加群'];
const AUTH_REQUIRED_ACTIONS = new Set([
  'login',
  'createItem',
  'classifyImage',
  'createComment',
  'sendThanks',
  'markReturned',
  'undoReturned',
  'reportContent'
]);
const visionRateLimiter = createRateLimiter({
  limit: Number(process.env.VISION_RATE_LIMIT || 8),
  windowMs: Number(process.env.VISION_RATE_WINDOW_MS || 60_000)
});
const QQ_REVIEW_CONFIG = {
  allowedGroupIds: parseCsv(process.env.QQ_REVIEW_GROUP_IDS),
  ingestToken: process.env.QQ_INGEST_TOKEN || '',
  adminToken: process.env.QQ_REVIEW_ADMIN_TOKEN || '',
  maxImageBytes: clampInteger(
    process.env.QQ_REVIEW_MAX_IMAGE_BYTES,
    8 * 1024 * 1024,
    1,
    10 * 1024 * 1024
  ),
  maxChunkBytes: clampInteger(
    process.env.QQ_REVIEW_MAX_CHUNK_BYTES,
    64 * 1024,
    1024,
    64 * 1024
  ),
  maxUploadChunks: clampInteger(
    process.env.QQ_REVIEW_MAX_UPLOAD_CHUNKS,
    256,
    1,
    256
  )
};

const HUNYUAN_CONFIG = {
  apiKey: process.env.HUNYUAN_API_KEY
    || process.env.TENCENTCLOUD_API_KEY
    || process.env.TENCENT_HUNYUAN_API_KEY
    || process.env.MODEL_API_KEY
    || '',
  baseUrl: (process.env.HUNYUAN_BASE_URL || 'https://api.hunyuan.cloud.tencent.com/v1').replace(/\/$/, ''),
  model: process.env.HUNYUAN_MODEL || 'hunyuan-vision',
  secretId: process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENT_SECRET_ID || '',
  secretKey: process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENT_SECRET_KEY || '',
  tencentEndpoint: (process.env.TENCENT_HUNYUAN_ENDPOINT || 'https://hunyuan.tencentcloudapi.com').replace(/\/$/, ''),
  tencentAction: 'ChatCompletions',
  tencentVersion: '2023-09-01',
  tencentService: 'hunyuan',
  tencentRegion: process.env.TENCENTCLOUD_REGION || process.env.TENCENT_REGION || ''
};

function optionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ok(data = {}) {
  return { ok: true, data };
}

function fail(message, code = 'BAD_REQUEST') {
  return { ok: false, code, message };
}

function now() {
  return db.serverDate();
}

function headerValue(headers = {}, name) {
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function parseRuntimeEvent(event = {}) {
  if (!event || typeof event !== 'object' || !event.body) return event || {};
  let body = event.body;
  if (event.isBase64Encoded && typeof body === 'string') {
    body = Buffer.from(body, 'base64').toString('utf8');
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return event;
    }
  }
  if (!body || typeof body !== 'object') return event;
  return {
    ...event,
    ...body,
    __headers: event.headers || {}
  };
}

function requireConfiguredToken(configuredToken, requestToken, missingMessage) {
  if (!configuredToken) return fail(missingMessage, 'NOT_CONFIGURED');
  if (!requestToken || !safeEqual(configuredToken, requestToken)) {
    return fail('凭据无效', 'FORBIDDEN');
  }
  return null;
}

function bearerToken(request) {
  const authorization = headerValue(request.__headers, 'authorization');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return String(request.ingestToken || request.adminToken || '').trim();
}

function classifyByText(text = '') {
  const source = text.toLowerCase();
  const categories = Object.keys(CATEGORY_KEYWORDS);
  for (let i = 0; i < categories.length; i += 1) {
    const category = categories[i];
    if (CATEGORY_KEYWORDS[category].some((word) => source.includes(word.toLowerCase()))) {
      return { category, aiTags: [category], confidence: 0.62 };
    }
  }
  return { category: '其他', aiTags: ['待确认'], confidence: 0 };
}

function unique(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

function parseJsonContent(content = '') {
  const cleaned = String(content)
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('混元未返回可解析的 JSON');
  return JSON.parse(match[0]);
}

function normalizeHunyuanResult(result = {}) {
  return {
    title: result.title || result.name || '',
    description: result.description || result.caption || result.visualDescription || '',
    category: result.category || '',
    tags: unique(result.tags || result.aiTags || result.keywords || []),
    colors: unique(result.colors || []),
    accessories: unique(result.accessories || []),
    objects: unique(result.objects || result.yoloObjects || []),
    imageEmbedding: result.imageEmbedding || result.image_embedding || [],
    semanticEmbedding: result.semanticEmbedding || result.semantic_embedding || result.embedding || []
  };
}

function normalizeImageBase64(imageBase64 = '', mimeType = 'image/jpeg') {
  const value = String(imageBase64 || '').trim();
  if (!value) return '';
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value)) return value;
  return `data:${mimeType || 'image/jpeg'};base64,${value.replace(/^data:[^,]+,/, '')}`;
}

function normalizeImageUrl(imageUrl = '') {
  const value = String(imageUrl || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const embeddedUrl = parsed.searchParams.get('mediaurl')
      || parsed.searchParams.get('imgurl')
      || parsed.searchParams.get('url');
    if (embeddedUrl && /^https?:\/\//i.test(embeddedUrl)) {
      return embeddedUrl;
    }
  } catch {
    // Keep the original value so callers still get a helpful model/provider error.
  }
  return value;
}

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value, 'utf8').digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function formatUtcDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function signTencentCloudRequest(payloadText, timestamp) {
  const endpointHost = new URL(HUNYUAN_CONFIG.tencentEndpoint).host;
  const date = formatUtcDate(timestamp);
  const canonicalHeaders = [
    'content-type:application/json; charset=utf-8',
    `host:${endpointHost}`,
    `x-tc-action:${HUNYUAN_CONFIG.tencentAction.toLowerCase()}`
  ].join('\n') + '\n';
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(payloadText)
  ].join('\n');
  const credentialScope = `${date}/${HUNYUAN_CONFIG.tencentService}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');
  const secretDate = hmac(`TC3${HUNYUAN_CONFIG.secretKey}`, date);
  const secretService = hmac(secretDate, HUNYUAN_CONFIG.tencentService);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  return [
    `TC3-HMAC-SHA256 Credential=${HUNYUAN_CONFIG.secretId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(', ');
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

async function callOpenAICompatibleHunyuanVision(payload) {
  const endpoint = `${HUNYUAN_CONFIG.baseUrl}/chat/completions`;
  const prompt = buildVisionPrompt(payload.hint);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${HUNYUAN_CONFIG.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: HUNYUAN_CONFIG.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: payload.imageUrl } },
            { type: 'text', text: prompt }
          ]
        }
      ],
      temperature: 0.2
    }),
    timeout: 30000
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error && (data.error.message || data.error.code);
    throw new Error(`混元识别失败 ${response.status}${message ? `: ${message}` : ''}`);
  }
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return normalizeHunyuanResult(parseJsonContent(content || ''));
}

async function callTencentCloudHunyuanVision(payload) {
  const endpointHost = new URL(HUNYUAN_CONFIG.tencentEndpoint).host;
  const requestBody = {
    Model: HUNYUAN_CONFIG.model,
    Stream: false,
    Temperature: 0.2,
    Messages: [
      {
        Role: 'user',
        Contents: [
          { Type: 'text', Text: buildVisionPrompt(payload.hint) },
          { Type: 'image_url', ImageUrl: { Url: payload.imageUrl } }
        ]
      }
    ]
  };
  const payloadText = JSON.stringify(requestBody);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    authorization: signTencentCloudRequest(payloadText, timestamp),
    'content-type': 'application/json; charset=utf-8',
    host: endpointHost,
    'x-tc-action': HUNYUAN_CONFIG.tencentAction,
    'x-tc-timestamp': String(timestamp),
    'x-tc-version': HUNYUAN_CONFIG.tencentVersion
  };
  if (HUNYUAN_CONFIG.tencentRegion) headers['x-tc-region'] = HUNYUAN_CONFIG.tencentRegion;

  const response = await fetch(HUNYUAN_CONFIG.tencentEndpoint, {
    method: 'POST',
    headers,
    body: payloadText,
    timeout: 30000
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.Response && data.Response.Error)) {
    const error = data.Response && data.Response.Error;
    const message = error && (error.Message || error.Code);
    throw new Error(`混元识别失败 ${response.status}${message ? `: ${message}` : ''}`);
  }
  const choices = (data.Response && data.Response.Choices) || data.Choices || [];
  const content = choices[0] && choices[0].Message && choices[0].Message.Content;
  return normalizeHunyuanResult(parseJsonContent(content || ''));
}

async function callHunyuanVision(payload) {
  if (HUNYUAN_CONFIG.secretId && HUNYUAN_CONFIG.secretKey) {
    return callTencentCloudHunyuanVision(payload);
  }
  return callOpenAICompatibleHunyuanVision(payload);
}

function mapTagsToCategory(tags = [], hint = '') {
  const source = `${tags.join(' ')} ${hint}`.toLowerCase();
  const categories = Object.keys(CATEGORY_KEYWORDS);
  for (let i = 0; i < categories.length; i += 1) {
    const category = categories[i];
    if (CATEGORY_KEYWORDS[category].some((word) => source.includes(word.toLowerCase()))) {
      return category;
    }
  }
  return '其他';
}

async function ensureUser(openid, profile = {}) {
  const userResult = await db.collection(COLLECTIONS.users).where({ _openid: openid }).limit(1).get();
  if (userResult.data.length) {
    const existing = userResult.data[0];
    const patch = {};
    if (profile.nickName && profile.nickName !== existing.nickName) patch.nickName = profile.nickName;
    if (profile.avatarUrl && profile.avatarUrl !== existing.avatarUrl) patch.avatarUrl = profile.avatarUrl;
    if (profile.email && profile.email !== existing.email) patch.email = profile.email;
    if (profile.contact && profile.contact !== existing.contact) patch.contact = profile.contact;
    if (Object.keys(patch).length) {
      patch.updatedAt = now();
      await db.collection(COLLECTIONS.users).doc(existing._id).update({ data: patch });
      return { ...existing, ...patch };
    }
    return existing;
  }
  const user = {
    nickName: profile.nickName || '微信用户',
    avatarUrl: profile.avatarUrl || '',
    email: profile.email || '',
    contact: profile.contact || profile.email || '',
    createdAt: now(),
    updatedAt: now()
  };
  const created = await db.collection(COLLECTIONS.users).add({ data: user });
  return { _id: created._id, _openid: openid, ...user };
}

async function createNotification(userOpenid, type, content, itemId, actorOpenid) {
  return db.collection(COLLECTIONS.notifications).add({
    data: {
      userOpenid,
      type,
      itemId,
      actorOpenid,
      content,
      read: false,
      createdAt: now()
    }
  });
}

async function login(event, context) {
  const user = await ensureUser(context.OPENID, event.profile || {});
  return ok(user);
}

async function listLocations(event) {
  const keyword = String(event.keyword || '').trim().slice(0, 50);
  const query = { enabled: true };
  if (keyword) {
    query.name = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
  }
  const result = await db.collection(COLLECTIONS.locations).where(query).orderBy('sortOrder', 'asc').get();
  return ok(result.data);
}

async function classifyImage(event, callerId) {
  if (!HUNYUAN_CONFIG.apiKey && !(HUNYUAN_CONFIG.secretId && HUNYUAN_CONFIG.secretKey)) {
    return fail('请先配置 HUNYUAN_API_KEY 或 TENCENT_SECRET_ID/TENCENT_SECRET_KEY', 'MODEL_NOT_CONFIGURED');
  }
  if (!callerId) return fail('请先登录后再使用 AI 图片识别', 'UNAUTHENTICATED');
  if (!event.fileId && !event.imageUrl && !event.imageBase64) {
    return fail('缺少图片 fileId、imageUrl 或 imageBase64');
  }
  const validation = validateVisionInput(event);
  if (!validation.ok) return fail(validation.message, validation.code);
  const rate = visionRateLimiter.check(callerId);
  if (!rate.allowed) return fail('AI 识别请求过于频繁，请稍后再试', 'RATE_LIMITED');

  let imageUrl = normalizeImageUrl(event.imageUrl || '');
  if (!imageUrl && event.imageBase64) {
    imageUrl = normalizeImageBase64(event.imageBase64, event.mimeType || event.contentType || 'image/jpeg');
  }
  if (!imageUrl && event.fileId) {
    const tempResult = await cloud.getTempFileURL({ fileList: [event.fileId] });
    const file = tempResult.fileList && tempResult.fileList[0];
    if (!file || !file.tempFileURL) return fail('无法获取图片临时链接');
    imageUrl = file.tempFileURL;
  }

  const payload = {
    imageUrl,
    fileId: event.fileId || '',
    hint: event.hint || ''
  };
  let semantic;
  try {
    semantic = await callHunyuanVision(payload);
  } catch (error) {
    return fail(error.message || '混元识别失败，请检查图片链接或模型权限', 'HUNYUAN_FAILED');
  }
  const aiTags = unique([
    ...semantic.tags,
    ...semantic.colors,
    ...semantic.accessories,
    ...semantic.objects
  ]);
  const category = semantic.category || mapTagsToCategory(aiTags, event.hint || semantic.description);
  const visualDescription = semantic.description || aiTags.join('、');

  return ok({
    title: semantic.title || category,
    category,
    aiTags,
    yoloObjects: semantic.objects,
    semanticTags: semantic.tags,
    visualDescription,
    imageEmbedding: semantic.imageEmbedding,
    semanticEmbedding: semantic.semanticEmbedding,
    modelSources: {
      provider: HUNYUAN_CONFIG.secretId && HUNYUAN_CONFIG.secretKey ? 'tencentcloud-hunyuan' : 'tencent-hunyuan-compatible',
      baseUrl: HUNYUAN_CONFIG.secretId && HUNYUAN_CONFIG.secretKey ? HUNYUAN_CONFIG.tencentEndpoint : HUNYUAN_CONFIG.baseUrl,
      model: HUNYUAN_CONFIG.model
    }
  });
}

async function createItem(event, context) {
  const payload = event.payload || {};
  if (!(payload.imageUrls || []).length && !payload.category) return fail('请上传图片或选择分类');
  if (String(payload.title || '').length > 80) return fail('物品标题不能超过 80 个字符');
  if (String(payload.description || '').length > 1000) return fail('物品描述不能超过 1000 个字符');
  let location = null;
  if (payload.locationId) {
    try {
      const locationResult = await db.collection(COLLECTIONS.locations).doc(payload.locationId).get();
      if (locationResult.data) location = locationResult.data;
    } catch (error) {
      // Web 端可能使用本地地点 id；查不到时退回名称与区域字段。
      location = null;
    }
  }
  const customLatitude = optionalNumber(payload.latitude);
  const customLongitude = optionalNumber(payload.longitude);
  const hasCustomLocation = !location && (payload.locationName || (customLatitude && customLongitude));
  const classification = payload.category
    ? { category: payload.category, aiTags: payload.aiTags || payload.tags || [] }
    : classifyByText(`${payload.title} ${payload.description || ''}`);
  const title = (payload.title || '').trim() || classification.category || '未命名物品';
  const data = {
    type: payload.type || 'found',
    title,
    description: payload.description || '',
    category: classification.category,
    aiTags: classification.aiTags,
    imageUrls: payload.imageUrls || [],
    thumbUrl: (payload.imageUrls || [])[0] || '',
    visualDescription: payload.visualDescription || '',
    yoloObjects: payload.yoloObjects || [],
    semanticTags: payload.semanticTags || [],
    imageEmbedding: payload.imageEmbedding || [],
    semanticEmbedding: payload.semanticEmbedding || [],
    locationId: location ? location._id : (payload.locationId || ''),
    locationName: location ? location.name : (payload.locationName || ''),
    locationArea: location ? location.area : (payload.locationArea || (hasCustomLocation ? '自定义位置' : '')),
    locationNearby: location ? location.nearby || [] : [],
    locationGuide: location ? location.detail || '' : (payload.locationGuide || ''),
    locationDetail: payload.locationDetail || '',
    mapX: location ? location.mapX : optionalNumber(payload.mapX),
    mapY: location ? location.mapY : optionalNumber(payload.mapY),
    latitude: location ? location.latitude : customLatitude,
    longitude: location ? location.longitude : customLongitude,
    status: 'active',
    ownerOpenid: context.OPENID,
    ownerName: payload.ownerName || '微信用户',
    ownerContact: payload.ownerContact || '',
    createdAt: now(),
    updatedAt: now()
  };
  const created = await db.collection(COLLECTIONS.items).add({ data });
  return ok(toPublicRecord({ _id: created._id, ...data }, context.OPENID));
}

async function listItems(event) {
  const filters = event.filters || {};
  const cursor = clampInteger(filters.cursor, 0, 0, 100_000);
  const limit = clampInteger(filters.limit, 20, 1, 50);
  const query = {};
  if (filters.status && filters.status !== 'all') {
    query.status = filters.status;
  } else if (!filters.status) {
    query.status = 'active';
  }
  if (filters.type) query.type = filters.type;
  if (filters.category && filters.category !== '全部') query.category = filters.category;
  if (filters.locationId) query.locationId = filters.locationId;
  const result = await db.collection(COLLECTIONS.items)
    .where(query)
    .orderBy('createdAt', 'desc')
    .skip(cursor)
    .limit(limit)
    .get();
  const callerId = event.__callerId || '';
  return ok({
    items: result.data.map((item) => toPublicRecord(item, callerId)),
    nextCursor: cursor + result.data.length
  });
}

async function getItemDetail(event) {
  const item = await db.collection(COLLECTIONS.items).doc(event.itemId).get();
  const comments = await db.collection(COLLECTIONS.comments)
    .where({ itemId: event.itemId, status: 'active' })
    .orderBy('createdAt', 'asc')
    .get();
  const callerId = event.__callerId || '';
  return ok({
    item: toPublicRecord(item.data, callerId),
    comments: comments.data.map((comment) => toPublicRecord(comment, callerId))
  });
}

async function createComment(event, context) {
  const content = (event.content || '').trim();
  if (!content) return fail('评论不能为空');
  if (content.length > 500) return fail('评论不能超过 500 个字符');
  if (BAD_WORDS.some((word) => content.includes(word))) return fail('评论包含敏感词');
  const itemResult = await db.collection(COLLECTIONS.items).doc(event.itemId).get();
  const item = itemResult.data;
  const data = {
    itemId: event.itemId,
    authorOpenid: context.OPENID,
    authorName: event.authorName || '微信用户',
    content,
    status: 'active',
    createdAt: now()
  };
  const created = await db.collection(COLLECTIONS.comments).add({ data });
  if (item.ownerOpenid !== context.OPENID) {
    await createNotification(item.ownerOpenid, 'comment', `${data.authorName} 评论了你的帖子：${item.title}`, event.itemId, context.OPENID);
  }
  return ok({ _id: created._id, ...data });
}

async function sendThanks(event, context) {
  const itemResult = await db.collection(COLLECTIONS.items).doc(event.itemId).get();
  const item = itemResult.data;
  if (item.ownerOpenid === context.OPENID) return fail('不能感谢自己发布的帖子');
  const existed = await db.collection(COLLECTIONS.thanks)
    .where({ itemId: event.itemId, fromOpenid: context.OPENID })
    .limit(1)
    .get();
  if (existed.data.length) return ok(existed.data[0]);
  const data = {
    itemId: event.itemId,
    fromOpenid: context.OPENID,
    toOpenid: item.ownerOpenid,
    createdAt: now()
  };
  const created = await db.collection(COLLECTIONS.thanks).add({ data });
  await createNotification(item.ownerOpenid, 'thanks', '有同学感谢了你发布的失物招领线索', event.itemId, context.OPENID);
  return ok({ _id: created._id, ...data });
}

async function updateReturnStatus(event, context, returned) {
  const itemResult = await db.collection(COLLECTIONS.items).doc(event.itemId).get();
  const item = itemResult.data;
  if (item.ownerOpenid !== context.OPENID) return fail('只能操作自己的帖子', 'FORBIDDEN');
  await db.collection(COLLECTIONS.items).doc(event.itemId).update({
    data: {
      status: returned ? 'returned' : 'active',
      returnedAt: returned ? now() : null,
      updatedAt: now()
    }
  });
  return ok({ itemId: event.itemId, status: returned ? 'returned' : 'active' });
}

async function reportContent(event, context) {
  const data = {
    targetType: event.targetType,
    targetId: event.targetId,
    reason: event.reason || '用户举报',
    reporterOpenid: context.OPENID,
    status: 'open',
    createdAt: now()
  };
  const created = await db.collection(COLLECTIONS.reports).add({ data });
  return ok({ _id: created._id, ...data });
}

function requireQQIngestToken(event) {
  return requireConfiguredToken(
    QQ_REVIEW_CONFIG.ingestToken,
    bearerToken(event),
    '请先在云函数环境变量中配置 QQ_INGEST_TOKEN'
  );
}

function normalizeQQMediaUpload(event = {}) {
  const groupId = String(event.groupId || event.group_id || '').trim().slice(0, 32);
  const messageId = String(event.messageId || event.message_id || '').trim().slice(0, 80);
  const mediaIndex = Number(event.mediaIndex);
  const contentType = String(event.contentType || '').toLowerCase();
  const bytes = Number(event.bytes);
  const digest = String(event.sha256 || '').toLowerCase();
  if (!groupId || !messageId) throw new Error('缺少 groupId 或 messageId');
  if (!Number.isInteger(mediaIndex) || mediaIndex < 0 || mediaIndex > 3) {
    throw new Error('mediaIndex 无效');
  }
  if (!QQ_REVIEW_IMAGE_TYPES.has(contentType)) throw new Error('图片格式不受支持');
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > QQ_REVIEW_CONFIG.maxImageBytes) {
    throw new Error('图片大小无效');
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('图片 sha256 无效');
  return {
    groupId,
    messageId,
    queueId: reviewId(groupId, messageId),
    mediaIndex,
    contentType,
    bytes,
    digest,
    originalFile: String(event.originalFile || '').slice(0, 180)
  };
}

function validateQQMediaGroup(groupId) {
  return QQ_REVIEW_CONFIG.allowedGroupIds.has(groupId)
    ? null
    : fail('群号不在云端审核白名单中', 'GROUP_NOT_ALLOWED');
}

async function uploadQQMediaChunk(event) {
  const tokenError = requireQQIngestToken(event);
  if (tokenError) return tokenError;

  let metadata;
  try {
    metadata = normalizeQQMediaUpload(event);
  } catch (error) {
    return fail(error.message, 'INVALID_QQ_MEDIA');
  }
  const groupError = validateQQMediaGroup(metadata.groupId);
  if (groupError) return groupError;

  const chunkIndex = Number(event.chunkIndex);
  const chunkCount = Number(event.chunkCount);
  if (
    !Number.isInteger(chunkIndex)
    || !Number.isInteger(chunkCount)
    || chunkCount < 1
    || chunkCount > QQ_REVIEW_CONFIG.maxUploadChunks
    || chunkIndex < 0
    || chunkIndex >= chunkCount
  ) {
    return fail('图片分片序号无效', 'INVALID_QQ_MEDIA_CHUNK');
  }
  const encoded = String(event.chunkBase64 || '').replace(/^data:[^,]+,/, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) {
    return fail('图片分片编码无效', 'INVALID_QQ_MEDIA_CHUNK');
  }
  const fileContent = Buffer.from(encoded, 'base64');
  if (!fileContent.length || fileContent.length > QQ_REVIEW_CONFIG.maxChunkBytes) {
    return fail('图片分片大小无效', 'INVALID_QQ_MEDIA_CHUNK');
  }

  const uploadDirectory = `qq-review-staging/${metadata.queueId}/${metadata.mediaIndex}-${metadata.digest.slice(0, 24)}`;
  const cloudPath = `${uploadDirectory}/${String(chunkIndex).padStart(4, '0')}.part`;
  const result = await cloud.uploadFile({ cloudPath, fileContent });
  return ok({
    fileId: result.fileID || result.fileId || '',
    chunkIndex,
    chunkCount,
    bytes: fileContent.length
  });
}

async function completeQQMediaUpload(event) {
  const tokenError = requireQQIngestToken(event);
  if (tokenError) return tokenError;

  let metadata;
  try {
    metadata = normalizeQQMediaUpload(event);
  } catch (error) {
    return fail(error.message, 'INVALID_QQ_MEDIA');
  }
  const groupError = validateQQMediaGroup(metadata.groupId);
  if (groupError) return groupError;

  const chunkCount = Number(event.chunkCount);
  const parts = Array.isArray(event.parts) ? event.parts : [];
  if (
    !Number.isInteger(chunkCount)
    || chunkCount < 1
    || chunkCount > QQ_REVIEW_CONFIG.maxUploadChunks
    || parts.length !== chunkCount
  ) {
    return fail('图片分片列表不完整', 'INVALID_QQ_MEDIA_PARTS');
  }

  const uploadDirectory = `qq-review-staging/${metadata.queueId}/${metadata.mediaIndex}-${metadata.digest.slice(0, 24)}`;
  let ordered;
  try {
    ordered = orderQQMediaParts(parts, chunkCount, uploadDirectory);
  } catch (error) {
    return fail(error.message, 'INVALID_QQ_MEDIA_PARTS');
  }

  const chunks = [];
  let totalBytes = 0;
  for (const fileId of ordered) {
    const downloaded = await cloud.downloadFile({ fileID: fileId });
    const chunk = Buffer.from(downloaded.fileContent || []);
    if (!chunk.length || chunk.length > QQ_REVIEW_CONFIG.maxChunkBytes) {
      return fail('云端图片分片大小无效', 'INVALID_QQ_MEDIA_PARTS');
    }
    totalBytes += chunk.length;
    if (totalBytes > QQ_REVIEW_CONFIG.maxImageBytes) {
      return fail('图片超过云端单图大小限制', 'INVALID_QQ_MEDIA');
    }
    chunks.push(chunk);
  }

  const fileContent = Buffer.concat(chunks);
  if (fileContent.length !== metadata.bytes || sha256(fileContent) !== metadata.digest) {
    return fail('图片合并校验失败', 'INVALID_QQ_MEDIA');
  }
  const extension = extensionForContentType(metadata.contentType);
  const cloudPath = `qq-review/${metadata.queueId}/${metadata.digest.slice(0, 24)}.${extension}`;
  const uploaded = await cloud.uploadFile({ cloudPath, fileContent });
  try {
    await cloud.deleteFile({ fileList: ordered });
  } catch (error) {
    console.warn('[lostfound] failed to remove QQ media staging chunks', error);
  }
  return ok({
    media: {
      fileId: uploaded.fileID || uploaded.fileId || '',
      contentType: metadata.contentType,
      bytes: fileContent.length,
      sha256: metadata.digest,
      originalFile: metadata.originalFile
    }
  });
}

function decodeReviewImage(media) {
  const base64 = String(media?.base64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) throw new Error('图片数据为空');
  const fileContent = Buffer.from(base64, 'base64');
  if (!fileContent.length || fileContent.length > QQ_REVIEW_CONFIG.maxImageBytes) {
    throw new Error('图片为空或超过云端单图大小限制');
  }
  const contentType = String(media.contentType || 'image/jpeg').toLowerCase();
  if (!QQ_REVIEW_IMAGE_TYPES.has(contentType)) {
    throw new Error('图片格式不受支持');
  }
  if (media.sha256 && !safeEqual(String(media.sha256).toLowerCase(), sha256(fileContent))) {
    throw new Error('图片校验失败');
  }
  return { fileContent, contentType };
}

function extensionForContentType(contentType) {
  return {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
  }[contentType] || 'jpg';
}

async function uploadQQReviewImages(queueId, mediaList = []) {
  const uploaded = [];
  for (const media of mediaList.slice(0, 4)) {
    const { fileContent, contentType } = decodeReviewImage(media);
    const digest = sha256(fileContent);
    const extension = extensionForContentType(contentType);
    const cloudPath = `qq-review/${queueId}/${digest.slice(0, 24)}.${extension}`;
    const result = await cloud.uploadFile({ cloudPath, fileContent });
    uploaded.push({
      fileId: result.fileID || result.fileId || '',
      contentType,
      bytes: fileContent.length,
      sha256: digest,
      originalFile: String(media.originalFile || '').slice(0, 180)
    });
  }
  return uploaded;
}

async function ingestQQMessage(event) {
  const tokenError = requireQQIngestToken(event);
  if (tokenError) return tokenError;

  let normalized;
  try {
    normalized = normalizeIncomingRecord(event.record || {});
  } catch (error) {
    return fail(error.message, 'INVALID_QQ_RECORD');
  }
  if (!QQ_REVIEW_CONFIG.allowedGroupIds.has(normalized.groupId)) {
    return fail('群号不在云端审核白名单中', 'GROUP_NOT_ALLOWED');
  }

  const queueId = reviewId(normalized.groupId, normalized.messageId);
  try {
    const existing = await db.collection(COLLECTIONS.qqReviewQueue).doc(queueId).get();
    if (existing?.data) {
      return ok({ queueId, duplicate: true, status: existing.data.status });
    }
  } catch {
    // A missing deterministic document is expected for first ingestion.
  }

  let uploadedImages;
  try {
    uploadedImages = normalizeQQMediaRefs(
      queueId,
      event.mediaRefs || [],
      QQ_REVIEW_CONFIG.maxImageBytes
    );
    const remainingSlots = Math.max(0, 4 - uploadedImages.length);
    if (remainingSlots) {
      uploadedImages.push(
        ...await uploadQQReviewImages(queueId, (event.media || []).slice(0, remainingSlots))
      );
    }
  } catch (error) {
    return fail(error.message, 'IMAGE_UPLOAD_FAILED');
  }

  const data = {
    ...normalized,
    images: uploadedImages,
    status: 'pending',
    receivedAt: now(),
    updatedAt: now()
  };
  await db.collection(COLLECTIONS.qqReviewQueue).doc(queueId).set({ data });
  return ok({
    queueId,
    duplicate: false,
    status: 'pending',
    imageCount: uploadedImages.length
  });
}

async function listQQReviewQueue(event) {
  const tokenError = requireConfiguredToken(
    QQ_REVIEW_CONFIG.adminToken,
    bearerToken(event),
    '请先在云函数环境变量中配置 QQ_REVIEW_ADMIN_TOKEN'
  );
  if (tokenError) return tokenError;
  const status = ['pending', 'approved', 'rejected'].includes(event.status)
    ? event.status
    : 'pending';
  const limit = clampInteger(event.limit, 50, 1, 100);
  const result = await db.collection(COLLECTIONS.qqReviewQueue)
    .where({ status })
    .orderBy('receivedAt', 'desc')
    .limit(limit)
    .get();
  return ok({
    items: result.data,
    status,
    count: result.data.length
  });
}

async function reviewQQItem(event) {
  const tokenError = requireConfiguredToken(
    QQ_REVIEW_CONFIG.adminToken,
    bearerToken(event),
    '请先在云函数环境变量中配置 QQ_REVIEW_ADMIN_TOKEN'
  );
  if (tokenError) return tokenError;
  const queueId = String(event.queueId || '').trim();
  const decision = String(event.decision || '').trim();
  if (!queueId || !['approve', 'reject'].includes(decision)) {
    return fail('缺少审核记录或审核动作');
  }

  const reviewResult = await db.collection(COLLECTIONS.qqReviewQueue).doc(queueId).get();
  const review = reviewResult?.data;
  if (!review) return fail('审核记录不存在', 'NOT_FOUND');
  if (review.status !== 'pending') {
    return fail(`该记录已经是 ${review.status} 状态`, 'ALREADY_REVIEWED');
  }

  if (decision === 'reject') {
    await db.collection(COLLECTIONS.qqReviewQueue).doc(queueId).update({
      data: {
        status: 'rejected',
        reviewNote: String(event.reviewNote || '').slice(0, 300),
        reviewedBy: 'website-admin',
        reviewedAt: now(),
        updatedAt: now()
      }
    });
    return ok({ queueId, status: 'rejected' });
  }

  const draft = sanitizeDraft(event.draft || {}, review.draft || {});
  const imageUrls = (review.images || []).map((image) => image.fileId).filter(Boolean);
  const itemData = {
    type: draft.type,
    title: draft.title,
    description: draft.description,
    category: draft.category,
    aiTags: draft.tags,
    imageUrls,
    thumbUrl: imageUrls[0] || '',
    visualDescription: '',
    yoloObjects: [],
    semanticTags: draft.tags,
    imageEmbedding: [],
    semanticEmbedding: [],
    locationId: draft.locationId,
    locationName: draft.locationName,
    locationArea: draft.locationArea,
    locationNearby: [],
    locationGuide: '',
    locationDetail: draft.locationDetail,
    mapX: null,
    mapY: null,
    latitude: null,
    longitude: null,
    status: 'active',
    ownerOpenid: `qq-import:${review.groupId}`,
    ownerName: 'QQ群成员',
    ownerContact: '',
    privacyRedacted: draft.privacyRedacted,
    source: {
      channel: 'QQ群',
      groupId: review.groupId,
      messageId: review.messageId,
      authorAlias: '群成员',
      sentAt: review.sentAt,
      message: draft.privacyRedacted ? '原始消息含隐私内容，公开版本已脱敏。' : review.content,
      reviewQueueId: queueId
    },
    createdAt: now(),
    updatedAt: now()
  };
  const created = await db.collection(COLLECTIONS.items).add({ data: itemData });
  await db.collection(COLLECTIONS.qqReviewQueue).doc(queueId).update({
    data: {
      status: 'approved',
      draft,
      publishedItemId: created._id,
      reviewedBy: 'website-admin',
      reviewedAt: now(),
      updatedAt: now()
    }
  });
  return ok({ queueId, status: 'approved', itemId: created._id });
}

exports.main = async (event = {}, runtimeContext = {}) => {
  event = parseRuntimeEvent(event);
  const context = cloud.getWXContext();
  const callerId = resolveCallerId(context, runtimeContext);
  const request = { ...event, __callerId: callerId };
  try {
    if (AUTH_REQUIRED_ACTIONS.has(request.action) && !callerId) {
      return fail('请先登录后再执行此操作', 'UNAUTHENTICATED');
    }
    switch (request.action) {
      case 'login':
        return login(request, { ...context, OPENID: callerId });
      case 'createItem':
        return createItem(request, { ...context, OPENID: callerId });
      case 'classifyImage':
        return classifyImage(request, callerId);
      case 'listItems':
        return listItems(request);
      case 'getItemDetail':
        return getItemDetail(request);
      case 'listLocations':
        return listLocations(request);
      case 'createComment':
        return createComment(request, { ...context, OPENID: callerId });
      case 'sendThanks':
        return sendThanks(request, { ...context, OPENID: callerId });
      case 'markReturned':
        return updateReturnStatus(request, { ...context, OPENID: callerId }, true);
      case 'undoReturned':
        return updateReturnStatus(request, { ...context, OPENID: callerId }, false);
      case 'reportContent':
        return reportContent(request, { ...context, OPENID: callerId });
      case 'uploadQQMediaChunk':
        return uploadQQMediaChunk(request);
      case 'completeQQMediaUpload':
        return completeQQMediaUpload(request);
      case 'ingestQQMessage':
        return ingestQQMessage(request);
      case 'listQQReviewQueue':
        return listQQReviewQueue(request);
      case 'reviewQQItem':
        return reviewQQItem(request);
      default:
        return fail(`未知 action: ${request.action}`);
    }
  } catch (error) {
    console.error('[lostfound] unhandled error', error);
    return fail('服务暂时不可用，请稍后再试', 'INTERNAL_ERROR');
  }
};
