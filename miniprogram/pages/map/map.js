const { listItems, searchLocations } = require('../../utils/store');
const { locationToCoordinate } = require('../../utils/locations');

const CAMPUS = {
  latitude: 31.179,
  longitude: 121.59,
  scale: 16
};

function groupItemsByLocation(items) {
  return items.reduce((groups, item) => {
    if (!item.locationId) return groups;
    if (!groups[item.locationId]) groups[item.locationId] = [];
    groups[item.locationId].push(item);
    return groups;
  }, {});
}

function buildMarker(location, markerId, isSelected) {
  const coordinate = locationToCoordinate(location);
  const hasItems = location.count > 0;
  const markerColor = hasItems ? '#0f766e' : '#98a2b3';

  return {
    id: markerId,
    locationId: location._id,
    title: location.name,
    latitude: coordinate.latitude,
    longitude: coordinate.longitude,
    alpha: hasItems ? 1 : 0.72,
    zIndex: hasItems ? 20 : 10,
    label: {
      content: String(location.count),
      color: '#ffffff',
      fontSize: 13,
      borderRadius: 18,
      bgColor: markerColor,
      padding: 6,
      textAlign: 'center'
    },
    callout: {
      content: `${location.name} · ${location.count}条`,
      color: hasItems ? '#0f766e' : '#667085',
      fontSize: 13,
      borderRadius: 6,
      bgColor: '#ffffff',
      padding: 8,
      display: hasItems || isSelected ? 'ALWAYS' : 'BYCLICK',
      textAlign: 'center'
    }
  };
}

Page({
  data: {
    campus: CAMPUS,
    markers: [],
    locations: [],
    selectedLocation: null,
    selectedItems: [],
    selectedLocationId: '',
    activeTotal: 0,
    activeLocationCount: 0
  },

  onShow() {
    this.loadMapData();
  },

  loadMapData() {
    const activeItems = listItems({ status: 'active' });
    const locatedItems = activeItems.filter((item) => item.locationId);
    const itemsByLocation = groupItemsByLocation(locatedItems);
    const locations = searchLocations().map((location) => {
      const items = itemsByLocation[location._id] || [];
      return Object.assign({}, location, { count: items.length });
    });
    const currentSelected = locations.find((location) => location._id === this.data.selectedLocationId);
    const firstActive = locations.find((location) => location.count > 0);
    const selectedLocation = currentSelected || firstActive || locations[0] || null;
    const markers = locations.map((location, index) => buildMarker(location, index + 1, selectedLocation && location._id === selectedLocation._id));

    this.setData({
      markers,
      locations,
      selectedLocation,
      selectedLocationId: selectedLocation ? selectedLocation._id : '',
      selectedItems: selectedLocation ? itemsByLocation[selectedLocation._id] || [] : [],
      activeTotal: locatedItems.length,
      activeLocationCount: locations.filter((location) => location.count > 0).length
    });
  },

  selectMarker(event) {
    const marker = this.data.markers.find((entry) => entry.id === event.detail.markerId);
    if (!marker) return;

    const selectedLocation = this.data.locations.find((location) => location._id === marker.locationId);
    const selectedItems = listItems({ status: 'active', locationId: marker.locationId });
    const markers = this.data.locations.map((location, index) => buildMarker(location, index + 1, location._id === marker.locationId));

    this.setData({
      markers,
      selectedLocation,
      selectedLocationId: marker.locationId,
      selectedItems
    });
  },

  goDetail(event) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${event.currentTarget.dataset.id}` });
  }
});
