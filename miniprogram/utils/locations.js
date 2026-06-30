const LOCATIONS = [
  { _id: 'lib', name: '图书馆', aliases: ['library'], area: '学习区', mapX: 54, mapY: 39, sortOrder: 1, enabled: true },
  { _id: 'sist', name: '信息学院楼', aliases: ['SIST', '信息学院'], area: '教学科研区', mapX: 63, mapY: 35, sortOrder: 2, enabled: true },
  { _id: 'spst', name: '物质学院楼', aliases: ['SPST', '物质学院'], area: '教学科研区', mapX: 48, mapY: 31, sortOrder: 3, enabled: true },
  { _id: 'slst', name: '生命学院楼', aliases: ['SLST', '生命学院'], area: '教学科研区', mapX: 37, mapY: 36, sortOrder: 4, enabled: true },
  { _id: 'dining', name: '学生食堂', aliases: ['食堂', '餐厅'], area: '生活区', mapX: 43, mapY: 58, sortOrder: 5, enabled: true },
  { _id: 'dorm-east', name: '东区宿舍', aliases: ['宿舍', '东宿'], area: '生活区', mapX: 67, mapY: 62, sortOrder: 6, enabled: true },
  { _id: 'dorm-west', name: '西区宿舍', aliases: ['西宿'], area: '生活区', mapX: 24, mapY: 61, sortOrder: 7, enabled: true },
  { _id: 'gym', name: '体育馆', aliases: ['运动场', '健身'], area: '运动区', mapX: 72, mapY: 47, sortOrder: 8, enabled: true },
  { _id: 'admin', name: '行政中心', aliases: ['行政楼'], area: '行政区', mapX: 30, mapY: 42, sortOrder: 9, enabled: true },
  { _id: 'gate', name: '校门口', aliases: ['门口', '入口'], area: '公共区', mapX: 14, mapY: 76, sortOrder: 10, enabled: true }
];

const CAMPUS_BOUNDS = {
  west: 121.5828,
  east: 121.5972,
  north: 31.184,
  south: 31.1742
};

function searchLocations(keyword = '') {
  const normalized = keyword.trim().toLowerCase();
  return LOCATIONS
    .filter((location) => {
      if (!location.enabled) return false;
      if (!normalized) return true;
      const haystack = [location.name, location.area].concat(location.aliases).join(' ').toLowerCase();
      return haystack.includes(normalized);
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function locationToCoordinate(location) {
  const longitude = CAMPUS_BOUNDS.west + ((CAMPUS_BOUNDS.east - CAMPUS_BOUNDS.west) * location.mapX) / 100;
  const latitude = CAMPUS_BOUNDS.north - ((CAMPUS_BOUNDS.north - CAMPUS_BOUNDS.south) * location.mapY) / 100;
  return { latitude, longitude };
}

function distanceInMeters(from, to) {
  const earthRadius = 6371000;
  const lat1 = (from.latitude * Math.PI) / 180;
  const lat2 = (to.latitude * Math.PI) / 180;
  const deltaLat = ((to.latitude - from.latitude) * Math.PI) / 180;
  const deltaLng = ((to.longitude - from.longitude) * Math.PI) / 180;
  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2)
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function formatDistance(distance) {
  if (distance >= 1000) return `约 ${(distance / 1000).toFixed(1)} 公里`;
  return `约 ${Math.round(distance)} 米`;
}

function findNearbyLocations(latitude, longitude, limit = 6) {
  const current = { latitude, longitude };
  return searchLocations()
    .map((location) => {
      const coordinate = locationToCoordinate(location);
      const distance = Math.round(distanceInMeters(current, coordinate));
      return {
        location,
        distance
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => Object.assign({}, entry.location, {
      distance: entry.distance,
      distanceText: formatDistance(entry.distance),
      meta: `${entry.location.area} · ${formatDistance(entry.distance)}`
    }));
}

function findNearestLocation(latitude, longitude, maxDistance = 800) {
  const nearest = findNearbyLocations(latitude, longitude, 1)[0];

  if (!nearest || nearest.distance > maxDistance) return null;
  return nearest;
}

module.exports = {
  LOCATIONS,
  searchLocations,
  locationToCoordinate,
  findNearbyLocations,
  findNearestLocation
};
