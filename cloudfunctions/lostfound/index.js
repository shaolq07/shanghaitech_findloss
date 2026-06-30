const cloud = require('wx-server-sdk');
const https = require('https');

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
  locations: 'campus_locations'
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

const IMAGE_PROVIDER = process.env.IMAGE_RECOGNITION_PROVIDER || 'tencent-hunyuan';
const HUNYUAN_API_KEY = process.env.TENCENTCLOUD_API_KEY || process.env.HUNYUAN_API_KEY;
const HUNYUAN_API_URL = process.env.HUNYUAN_API_URL || 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions';
const DEFAULT_HUNYUAN_VISION_MODEL = 'hunyuan-vision';
const HUNYUAN_VISION_MODEL = process.env.HUNYUAN_VISION_MODEL === 'hunyuan-vision-1.5-instruct'
  ? DEFAULT_HUNYUAN_VISION_MODEL
  : (process.env.HUNYUAN_VISION_MODEL || DEFAULT_HUNYUAN_VISION_MODEL);

const CATEGORY_ALIASES = {
  '证件': ['证件', '身份证', '学生证', '护照', '驾驶证', '银行卡', '卡片'],
  '电子产品': ['手机', '电脑', '笔记本电脑', '平板', '耳机', '充电器', '数据线', '相机', '鼠标', '键盘', 'u盘', '硬盘', '电子'],
  '书本资料': ['书', '教材', '笔记本', '笔记', '资料', '文件', '试卷', '纸张', '书包'],
  '衣物': ['衣服', '外套', '上衣', '裤子', '帽子', '围巾', '手套', '鞋', '包'],
  '钥匙': ['钥匙', '钥匙串', '门禁'],
  '校园卡': ['校园卡', '一卡通', '饭卡', '学生卡'],
  '雨伞': ['伞', '雨伞', '折叠伞'],
  '水杯': ['杯', '水杯', '保温杯', '杯子', '瓶子', '水瓶']
};

function ok(data = {}) {
  return { ok: true, data };
}

function fail(message, code = 'BAD_REQUEST') {
  return { ok: false, code, message };
}

function now() {
  return db.serverDate();
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

function hasHunyuanCredentials() {
  return Boolean(HUNYUAN_API_KEY);
}

async function getImageBase64(fileId) {
  if (!fileId) throw new Error('缺少图片 fileId');
  const result = await cloud.downloadFile({ fileID: fileId });
  return Buffer.from(result.fileContent).toString('base64');
}

function normalizeText(text = '') {
  return String(text).trim().toLowerCase();
}

function mapCategoryFromLabels(labels = []) {
  const source = labels
    .map((label) => [label.name, label.firstCategory, label.secondCategory, label.parents].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();

  const categories = Object.keys(CATEGORY_ALIASES);
  for (let i = 0; i < categories.length; i += 1) {
    const category = categories[i];
    if (CATEGORY_ALIASES[category].some((word) => source.includes(normalizeText(word)))) {
      return category;
    }
  }
  return '其他';
}

function unique(values) {
  const seen = {};
  return values.filter((value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen[normalized]) return false;
    seen[normalized] = true;
    return true;
  });
}

function sanitizeErrorText(text = '') {
  return String(text).replace(/sk-[A-Za-z0-9_*.-]{8,}/g, '[redacted-api-key]');
}

function postJson(urlString, payload, headers = {}) {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: url.port || 443,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }, headers),
      timeout: 25000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${sanitizeErrorText(text).slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`响应不是 JSON: ${text.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('图像识别请求超时'));
    });
    req.write(body);
    req.end();
  });
}

function isHunyuanConfigError(error) {
  const message = String(error && (error.message || error) || '');
  return /HTTP 401|HTTP 403|Incorrect API key|invalid api key|unauthorized|forbidden/i.test(message);
}

function extractJsonObject(content = '') {
  const text = String(content).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    const matched = text.match(/\{[\s\S]*\}/);
    if (!matched) throw error;
    return JSON.parse(matched[0]);
  }
}

function normalizeVisionResult(result = {}) {
  const rawTags = Array.isArray(result.aiTags) ? result.aiTags : (Array.isArray(result.labels) ? result.labels : []);
  const labels = rawTags
    .map((tag) => (typeof tag === 'string' ? { name: tag } : { name: tag.name || tag.label || '', confidence: tag.confidence || tag.score || 0 }))
    .filter((label) => label.name);
  const itemName = String(result.itemName || result.title || (labels[0] && labels[0].name) || '').trim();
  const categories = Object.keys(CATEGORY_ALIASES);
  const category = categories.includes(result.category)
    ? result.category
    : mapCategoryFromLabels([{ name: itemName }].concat(labels));
  const confidenceValue = Number(result.confidence || (labels[0] && labels[0].confidence) || 0);
  const confidence = confidenceValue > 1 ? Math.round(confidenceValue) / 100 : confidenceValue;
  const tagNames = unique(labels.map((label) => label.name)).slice(0, 4);

  return {
    itemName,
    title: itemName,
    category,
    aiTags: unique(['图片识别'].concat(tagNames, category === '其他' ? [] : [category])),
    confidence,
    description: result.description || '',
    provider: 'tencent-hunyuan'
  };
}

async function callHunyuanVision(imageBase64, hint = '') {
  const categories = Object.keys(CATEGORY_ALIASES).join('、');
  const prompt = [
    '请识别图片中的主要失物或拾物，只返回 JSON，不要输出 Markdown。',
    `category 必须从以下枚举中选择：${categories}、其他。`,
    'JSON 格式：{"itemName":"简短中文物品名","category":"分类","aiTags":["标签1","标签2"],"confidence":0.0,"description":"一句适合招领帖的描述"}。',
    '如果图片中有多个物体，选择最像用户要发布的那个；不要猜测姓名、学号、手机号等隐私。',
    hint ? `用户已有提示：${hint}` : ''
  ].filter(Boolean).join('\n');

  const response = await postJson(HUNYUAN_API_URL, {
    model: HUNYUAN_VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ]
      }
    ],
    temperature: 0.1,
    max_tokens: 300
  }, {
    Authorization: `Bearer ${HUNYUAN_API_KEY}`
  });

  const content = response.choices
    && response.choices[0]
    && response.choices[0].message
    && response.choices[0].message.content;
  return normalizeVisionResult(extractJsonObject(content || ''));
}

function buildImageClassificationResult(classification, hint = '') {
  const trimmedHint = (hint || '').trim();
  const itemName = classification.category === '其他' ? '' : classification.category;
  const title = itemName || (trimmedHint.length <= 18 ? trimmedHint : '');
  return {
    itemName: title,
    title,
    category: classification.category,
    aiTags: ['图片识别'].concat(classification.aiTags || []),
    confidence: classification.confidence,
    description: '',
    provider: 'text-fallback'
  };
}

async function ensureUser(openid, profile = {}) {
  const userResult = await db.collection(COLLECTIONS.users).where({ _openid: openid }).limit(1).get();
  if (userResult.data.length) {
    return userResult.data[0];
  }
  const user = {
    nickName: profile.nickName || '微信用户',
    avatarUrl: profile.avatarUrl || '',
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
  const keyword = (event.keyword || '').trim();
  const query = { enabled: true };
  if (keyword) {
    query.name = db.RegExp({ regexp: keyword, options: 'i' });
  }
  const result = await db.collection(COLLECTIONS.locations).where(query).orderBy('sortOrder', 'asc').get();
  return ok(result.data);
}

async function classifyImage(event) {
  if (IMAGE_PROVIDER !== 'tencent-hunyuan' || !hasHunyuanCredentials() || !event.fileId) {
    const classification = classifyByText(event.hint || '');
    return ok(buildImageClassificationResult(classification, event.hint || ''));
  }

  try {
    const imageBase64 = await getImageBase64(event.fileId);
    return ok(await callHunyuanVision(imageBase64, event.hint || ''));
  } catch (error) {
    console.warn('Image classification failed:', error.message || error);
    if (isHunyuanConfigError(error)) {
      return fail('腾讯混元 API Key 无效或未授权，请重新配置 HUNYUAN_API_KEY', 'HUNYUAN_AUTH_ERROR');
    }
    const classification = classifyByText(event.hint || '');
    return ok(buildImageClassificationResult(classification, event.hint || ''));
  }
}

async function createItem(event, context) {
  const payload = event.payload || {};
  if (!(payload.imageUrls || []).length && !payload.category) return fail('请上传图片或选择分类');
  let location = null;
  if (payload.locationId) {
    const locationResult = await db.collection(COLLECTIONS.locations).doc(payload.locationId).get();
    location = locationResult.data;
  }
  const classification = payload.category
    ? { category: payload.category, aiTags: payload.aiTags || [] }
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
    locationId: location ? location._id : '',
    locationName: location ? location.name : '',
    locationDetail: '',
    mapX: location ? location.mapX : null,
    mapY: location ? location.mapY : null,
    status: 'active',
    ownerOpenid: context.OPENID,
    ownerName: payload.ownerName || '微信用户',
    createdAt: now(),
    updatedAt: now()
  };
  const created = await db.collection(COLLECTIONS.items).add({ data });
  return ok({ _id: created._id, ...data });
}

async function listItems(event) {
  const filters = event.filters || {};
  const query = { status: filters.status || 'active' };
  if (filters.category && filters.category !== '全部') query.category = filters.category;
  if (filters.locationId) query.locationId = filters.locationId;
  const result = await db.collection(COLLECTIONS.items)
    .where(query)
    .orderBy('createdAt', 'desc')
    .skip(filters.cursor || 0)
    .limit(filters.limit || 20)
    .get();
  return ok({ items: result.data, nextCursor: (filters.cursor || 0) + result.data.length });
}

async function getItemDetail(event) {
  const item = await db.collection(COLLECTIONS.items).doc(event.itemId).get();
  const comments = await db.collection(COLLECTIONS.comments)
    .where({ itemId: event.itemId, status: 'active' })
    .orderBy('createdAt', 'asc')
    .get();
  return ok({ item: item.data, comments: comments.data });
}

async function createComment(event, context) {
  const content = (event.content || '').trim();
  if (!content) return fail('评论不能为空');
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

exports.main = async (event) => {
  const context = cloud.getWXContext();
  try {
    switch (event.action) {
      case 'login':
        return login(event, context);
      case 'createItem':
        return createItem(event, context);
      case 'classifyImage':
        return classifyImage(event);
      case 'listItems':
        return listItems(event);
      case 'getItemDetail':
        return getItemDetail(event);
      case 'listLocations':
        return listLocations(event);
      case 'createComment':
        return createComment(event, context);
      case 'sendThanks':
        return sendThanks(event, context);
      case 'markReturned':
        return updateReturnStatus(event, context, true);
      case 'undoReturned':
        return updateReturnStatus(event, context, false);
      case 'reportContent':
        return reportContent(event, context);
      default:
        return fail(`未知 action: ${event.action}`);
    }
  } catch (error) {
    return fail(error.message || '服务异常', 'INTERNAL_ERROR');
  }
};
