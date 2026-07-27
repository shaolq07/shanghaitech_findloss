const crypto = require('crypto');

const QQ_REVIEW_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);
const DEFAULT_ALLOWED_GROUPS = ['731332881'];
const CATEGORY_RULES = [
  ['校园卡', ['校园卡', '一卡通', '饭卡']],
  ['电子产品', ['手机', '电脑', '耳机', '充电器', '平板', '相机', '拍立得', '鼠标']],
  ['证件', ['身份证', '学生证', '护照', '银行卡', '证件']],
  ['书本资料', ['书', '教材', '笔记', '资料', '报告', '文件']],
  ['衣物', ['衣服', '外套', '帽子', '围巾', '手套', '短袖', 't恤']],
  ['钥匙', ['钥匙', '门禁']],
  ['雨伞', ['雨伞', '伞']],
  ['水杯', ['水杯', '杯子', '保温杯']]
];
const LOCATION_RULES = [
  ['teaching', ['教学中心', '教室', 'tc']],
  ['cainiao', ['菜鸟', '驿站', '快递']],
  ['dao-college', ['大道书院', '大道宿舍']],
  ['music-venue', ['音乐会', '会场']],
  ['pickup-lockers', ['取件柜', '快递柜']]
];

function safeEqual(left = '', right = '') {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCsv(value, fallback = DEFAULT_ALLOWED_GROUPS) {
  const entries = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new Set(entries.length ? entries : fallback);
}

function clampText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function sha256(value) {
  return crypto.createHash('sha256').update(
    Buffer.isBuffer(value) ? value : String(value)
  ).digest('hex');
}

function reviewId(groupId, messageId) {
  return `qq_${sha256(`${groupId}:${messageId}`).slice(0, 40)}`;
}

function detectRiskFlags(content, images = []) {
  const text = String(content || '');
  const risks = [];
  if (images.length) risks.push('IMAGE_REVIEW_REQUIRED');
  if (/(?:1[3-9]\d{9})/.test(text)) risks.push('PHONE_NUMBER');
  if (/(?:qq|企鹅)[：:\s]*\d{5,12}/i.test(text)) risks.push('QQ_NUMBER');
  if (/\b\d{15,18}[0-9xX]\b/.test(text)) risks.push('IDENTITY_NUMBER');
  if (/(?:学号|姓名|身份证|银行卡|手机号)/.test(text)) risks.push('POSSIBLE_PERSONAL_DATA');
  return risks;
}

function chooseByRules(content, rules, fallback) {
  const normalized = String(content || '').toLowerCase();
  const match = rules.find(([, keywords]) => (
    keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))
  ));
  return match ? match[0] : fallback;
}

function makeDraft(record) {
  const content = clampText(record.content, 1000);
  const lostFoundType = record.lost_found?.type;
  const type = lostFoundType === 'lost' || lostFoundType === 'found'
    ? lostFoundType
    : 'found';
  const category = chooseByRules(content, CATEGORY_RULES, '其他');
  const locationId = chooseByRules(content, LOCATION_RULES, '');
  const fallbackTitle = type === 'lost' ? `QQ群寻物线索：${category}` : `QQ群招领线索：${category}`;

  return {
    type,
    title: clampText(content.split(/[。！？!?\n]/)[0], 40) || fallbackTitle,
    description: content || '群成员发送了一条图片线索，请审核图片后补充描述。',
    category,
    locationId,
    locationName: '',
    locationArea: '',
    locationDetail: '',
    tags: [category],
    privacyRedacted: false
  };
}

function normalizeIncomingRecord(record = {}) {
  const groupId = clampText(record.group_id, 32);
  const messageId = clampText(record.message_id, 80);
  if (!groupId || !messageId) throw new Error('缺少 group_id 或 message_id');

  const images = Array.isArray(record.images)
    ? record.images.slice(0, 4).map((image) => ({
      originalFile: clampText(image.original_file, 180),
      relativePath: clampText(image.relative_path, 500),
      sha256: clampText(image.sha256, 80),
      bytes: Number(image.bytes) || 0,
      source: clampText(image.source, 40)
    }))
    : [];

  return {
    groupId,
    messageId,
    sourceKey: `qq:${groupId}:${messageId}`,
    sentAt: clampText(record.time, 60) || new Date().toISOString(),
    senderIdHash: record.sender_id ? sha256(record.sender_id).slice(0, 24) : '',
    senderAlias: clampText(record.sender_name, 80) || '群成员',
    messageType: clampText(record.message_type, 30) || 'unknown',
    content: clampText(record.content, 2000),
    classification: {
      type: ['lost', 'found', 'unknown'].includes(record.lost_found?.type)
        ? record.lost_found.type
        : 'unknown',
      confidence: Number(record.lost_found?.confidence) || 0,
      matchedKeywords: Array.isArray(record.lost_found?.matched_keywords)
        ? record.lost_found.matched_keywords.map((entry) => clampText(entry, 30)).slice(0, 12)
        : []
    },
    images,
    draft: makeDraft(record),
    riskFlags: detectRiskFlags(record.content, images)
  };
}

function sanitizeDraft(input = {}, fallback = {}) {
  const allowedTypes = new Set(['lost', 'found']);
  const type = allowedTypes.has(input.type) ? input.type : (fallback.type || 'found');
  const category = clampText(input.category || fallback.category || '其他', 30);
  return {
    type,
    title: clampText(input.title || fallback.title, 80) || 'QQ群失物线索',
    description: clampText(input.description || fallback.description, 1000),
    category,
    locationId: clampText(input.locationId || fallback.locationId, 80),
    locationName: clampText(input.locationName || fallback.locationName, 100),
    locationArea: clampText(input.locationArea || fallback.locationArea, 100),
    locationDetail: clampText(input.locationDetail || fallback.locationDetail, 300),
    tags: Array.from(new Set([
      category,
      ...(Array.isArray(input.tags) ? input.tags : fallback.tags || [])
    ].map((entry) => clampText(entry, 30)).filter(Boolean))).slice(0, 12),
    privacyRedacted: Boolean(input.privacyRedacted)
  };
}

function cloudFileContainsPath(fileId, expectedPath) {
  return String(fileId || '').replace(/\\/g, '/').includes(`/${expectedPath}`);
}

function normalizeQQMediaRefs(queueId, mediaRefs = [], maxImageBytes = 8 * 1024 * 1024) {
  if (!Array.isArray(mediaRefs)) return [];
  return mediaRefs.slice(0, 4).map((media) => {
    const fileId = String(media?.fileId || '');
    const contentType = String(media?.contentType || '').toLowerCase();
    const bytes = Number(media?.bytes);
    const digest = String(media?.sha256 || '').toLowerCase();
    const expectedPath = `qq-review/${queueId}/${digest.slice(0, 24)}.`;
    if (
      !QQ_REVIEW_IMAGE_TYPES.has(contentType)
      || !Number.isInteger(bytes)
      || bytes < 1
      || bytes > maxImageBytes
      || !/^[a-f0-9]{64}$/.test(digest)
      || !cloudFileContainsPath(fileId, expectedPath)
    ) {
      throw new Error('云存储图片引用无效');
    }
    return {
      fileId,
      contentType,
      bytes,
      sha256: digest,
      originalFile: clampText(media.originalFile, 180)
    };
  });
}

function orderQQMediaParts(parts, chunkCount, uploadDirectory) {
  const ordered = new Array(chunkCount);
  for (const part of parts) {
    const index = Number(part?.index);
    const fileId = String(part?.fileId || '');
    const expectedPath = `${uploadDirectory}/${String(index).padStart(4, '0')}.part`;
    if (
      !Number.isInteger(index)
      || index < 0
      || index >= chunkCount
      || ordered[index]
      || !cloudFileContainsPath(fileId, expectedPath)
    ) {
      throw new Error('图片分片引用无效');
    }
    ordered[index] = fileId;
  }
  if (ordered.filter(Boolean).length !== chunkCount) {
    throw new Error('图片分片引用不完整');
  }
  return ordered;
}

module.exports = {
  QQ_REVIEW_IMAGE_TYPES,
  DEFAULT_ALLOWED_GROUPS,
  cloudFileContainsPath,
  detectRiskFlags,
  normalizeQQMediaRefs,
  normalizeIncomingRecord,
  orderQQMediaParts,
  parseCsv,
  reviewId,
  safeEqual,
  sanitizeDraft,
  sha256
};
