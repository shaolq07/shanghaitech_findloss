import { categoryImages, seedItems } from './data.js';
import { classifyByText } from './utils.js';

const STORAGE_KEY = 'shanghaitech_lostfound_web_v1';
const AUTH_KEY = 'shanghaitech_lostfound_web_user_v1';
const seedItemIds = new Set(seedItems.map((item) => item.id));
const legacyFallbackImages = new Set(Object.values(categoryImages));
const imageFileName = (value) => String(value || '').split(/[?#]/, 1)[0].split('/').pop();
const legacyFallbackImageFiles = new Set(
  [...legacyFallbackImages].map(imageFileName).filter(Boolean)
);

function removeLegacyFallbackImage(item) {
  const isLegacyFallback = legacyFallbackImages.has(item?.image)
    || legacyFallbackImageFiles.has(imageFileName(item?.image));

  if (!item || seedItemIds.has(item.id) || !isLegacyFallback) {
    return item;
  }

  const images = Array.isArray(item.images)
    ? item.images.filter((image) => (
      !legacyFallbackImages.has(image)
      && !legacyFallbackImageFiles.has(imageFileName(image))
    ))
    : item.images;

  return {
    ...item,
    image: images?.[0] || '',
    ...(Array.isArray(images) ? { images } : {})
  };
}

export function loadItems() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return seedItems;
  try {
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed.items)) return seedItems;
    const sanitizedItems = parsed.items.map(removeLegacyFallbackImage);
    const savedIds = new Set(sanitizedItems.map((item) => item.id));
    const newlyImportedItems = seedItems.filter(
      (item) => item.source?.channel === 'QQ群' && !savedIds.has(item.id)
    );
    return [...newlyImportedItems, ...sanitizedItems];
  } catch {
    return seedItems;
  }
}

export function saveItems(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ items }));
}

export function loadUser() {
  const saved = localStorage.getItem(AUTH_KEY);
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved);
    return parsed && parsed.user ? parsed.user : null;
  } catch {
    return null;
  }
}

export function saveUser(user) {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ user }));
}

export function clearUser() {
  localStorage.removeItem(AUTH_KEY);
}

export function createItem(payload) {
  const classification = payload.category
    ? { category: payload.category, tags: payload.tags || [] }
    : classifyByText(`${payload.title} ${payload.description}`);

  return {
    id: `item_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type: payload.type,
    title: payload.title.trim(),
    description: payload.description.trim(),
    category: classification.category,
    tags: Array.from(new Set([classification.category, ...(payload.tags || classification.tags || [])])).filter(Boolean),
    image: payload.image || '',
    visualDescription: payload.visualDescription || '',
    rawPredictions: payload.rawPredictions || [],
    locationId: payload.locationId,
    ownerName: payload.ownerName || '网页用户',
    status: 'active',
    createdAt: new Date().toISOString()
  };
}
