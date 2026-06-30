const { CATEGORIES } = require('../../utils/constants');
const { createItem, searchLocations, classifyByText } = require('../../utils/store');
const { findNearbyLocations, findNearestLocation } = require('../../utils/locations');

function initialForm() {
  return {
    type: 'found',
    title: '',
    description: '',
    category: '',
    aiTags: [],
    imageUrls: [],
    imageFileId: '',
    locationId: ''
  };
}

function getSelectedLocation(locationId) {
  if (!locationId) return null;
  return searchLocations().find((location) => location._id === locationId) || null;
}

function getFoundItemName(form) {
  const title = (form.title || '').trim();
  if (title) return title;
  if (form.category && form.category !== '其他') return `一件${form.category}`;
  return '一件物品';
}

function buildFoundDescription(form) {
  const itemName = getFoundItemName(form);
  const location = getSelectedLocation(form.locationId);
  const placeText = location ? `${location.name}附近` : '校内';
  return `在${placeText}捡到${itemName}。请失主在评论中说明物品特征，确认无误后再约时间地点领取。`;
}

function getFileExtension(filePath) {
  const matched = String(filePath || '').match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return matched ? matched[1] : 'jpg';
}

function uploadImageForRecognition(filePath) {
  const cloudPath = `lostfound/${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${getFileExtension(filePath)}`;
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: resolve,
      fail: reject
    });
  });
}

function callImageClassifier(fileId, hint) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'lostfound',
      data: {
        action: 'classifyImage',
        fileId,
        hint
      },
      success: resolve,
      fail: reject
    });
  });
}

Page({
  data: {
    categories: CATEGORIES,
    locationKeyword: '',
    locations: searchLocations(),
    locationListTitle: '全部地点',
    form: initialForm(),
    descriptionAutoFilled: false,
    imageDetecting: false,
    imageHint: '',
    locationDetecting: false,
    locationHint: ''
  },

  onLoad(options) {
    const nextForm = initialForm();
    if (options.type) nextForm.type = options.type;
    if (options.image) {
      nextForm.imageUrls = [decodeURIComponent(options.image)];
      nextForm.category = '其他';
      nextForm.aiTags = ['图片自动识别'];
    }
    this.setData({ form: nextForm }, () => {
      this.updateFoundDescription(false);
      this.locateCurrentPosition();
      if (options.image) {
        this.setData({
          imageDetecting: true,
          imageHint: '正在识别图片中的物品...'
        });
        this.detectImageItem(nextForm.imageUrls[0]);
      }
    });
  },

  setType(event) {
    const type = event.currentTarget.dataset.type;
    const nextData = {
      'form.type': type
    };
    if (type === 'lost' && this.data.descriptionAutoFilled) {
      nextData['form.description'] = '';
      nextData.descriptionAutoFilled = false;
    }
    this.setData(nextData, () => this.updateFoundDescription(false));
  },

  setCategory(event) {
    this.setData({
      'form.category': event.currentTarget.dataset.category,
      'form.aiTags': ['手动校正']
    }, () => this.updateFoundDescription(false));
  },

  clearCategory() {
    this.setData({
      'form.category': '',
      'form.aiTags': []
    }, () => this.updateFoundDescription(false));
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.detail.value;
    const nextForm = Object.assign({}, this.data.form, { [field]: value });
    const nextData = { [`form.${field}`]: value };
    if (field === 'description') {
      nextData.descriptionAutoFilled = false;
    }
    this.setData(nextData);
    if (field === 'title' || field === 'description') {
      const result = classifyByText(`${nextForm.title} ${nextForm.description}`);
      if (result.confidence > 0 || value.trim()) {
        this.setData({
          'form.category': result.category,
          'form.aiTags': result.aiTags
        }, () => {
          if (field === 'title') this.updateFoundDescription(false);
        });
        return;
      }
    }
    if (field === 'title') this.updateFoundDescription(false);
  },

  searchLocation(event) {
    const keyword = event.detail.value;
    this.setData({
      locationKeyword: keyword,
      locations: searchLocations(keyword),
      locationListTitle: keyword ? '搜索结果' : '全部地点',
      locationHint: keyword ? '' : this.data.locationHint
    });
  },

  selectLocation(event) {
    const location = searchLocations().find((entry) => entry._id === event.currentTarget.dataset.id);
    this.setData({
      'form.locationId': event.currentTarget.dataset.id,
      locationKeyword: location ? location.name : this.data.locationKeyword,
      locationHint: location ? `已选择：${location.name}` : ''
    }, () => this.updateFoundDescription(false));
  },

  clearLocation() {
    this.setData({
      'form.locationId': '',
      locationKeyword: '',
      locations: searchLocations(),
      locationListTitle: '全部地点',
      locationHint: ''
    }, () => this.updateFoundDescription(false));
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles[0];
        this.setData({
          'form.imageUrls': [file.tempFilePath],
          'form.category': this.data.form.category || '其他',
          'form.aiTags': this.data.form.aiTags.length ? this.data.form.aiTags : ['图片待识别'],
          imageHint: '正在识别图片中的物品...',
          imageDetecting: true
        }, () => {
          this.updateFoundDescription(false);
          this.detectImageItem(file.tempFilePath);
        });
        wx.showToast({ title: '图片已选择', icon: 'success' });
      }
    });
  },

  locateCurrentPosition() {
    if (!wx.getLocation) {
      this.setData({ locationHint: '当前微信版本不支持自动定位，请手动选择地点' });
      return;
    }
    this.setData({
      locationDetecting: true,
      locationHint: '正在获取当前位置...'
    });
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        const nearbyLocations = findNearbyLocations(res.latitude, res.longitude, 6);
        const nearest = findNearestLocation(res.latitude, res.longitude);
        if (!nearest) {
          this.setData({
            locations: nearbyLocations.length ? nearbyLocations : searchLocations(),
            locationListTitle: nearbyLocations.length ? '附近地点' : '全部地点',
            locationDetecting: false,
            locationHint: nearbyLocations.length ? '未能自动确认地点，请从附近地点中选择' : '未匹配到附近校内地点，请手动选择'
          });
          return;
        }
        this.setData({
          'form.locationId': nearest._id,
          locationKeyword: nearest.name,
          locations: nearbyLocations.length ? nearbyLocations : searchLocations(nearest.name),
          locationListTitle: nearbyLocations.length ? '附近地点' : '搜索结果',
          locationDetecting: false,
          locationHint: `已自动定位到：${nearest.name}（${nearest.distanceText}），也可从附近地点中改选`
        }, () => this.updateFoundDescription(false));
      },
      fail: () => {
        this.setData({
          locations: searchLocations(),
          locationListTitle: '全部地点',
          locationDetecting: false,
          locationHint: '定位未授权或失败，请手动选择地点'
        });
      }
    });
  },

  detectImageItem(filePath) {
    const app = getApp();
    const hint = `${this.data.form.title} ${this.data.form.description}`.trim();

    if (!app.globalData.cloudReady || !wx.cloud) {
      const fallback = classifyByText(hint);
      const nextData = {
        imageDetecting: false,
        imageHint: '已选择图片；配置云端图像识别后可自动提取物品'
      };
      if (fallback.confidence > 0) {
        nextData['form.category'] = fallback.category;
        nextData['form.aiTags'] = fallback.aiTags;
      }
      this.setData(nextData, () => this.updateFoundDescription(false));
      return;
    }

    uploadImageForRecognition(filePath)
      .then((uploadRes) => {
        return callImageClassifier(uploadRes.fileID, hint).then((classifyRes) => {
          const result = classifyRes.result && classifyRes.result.ok ? classifyRes.result.data : {};
          return Object.assign({}, result, { fileId: uploadRes.fileID });
        });
      })
      .then((result) => this.applyImageRecognition(result))
      .catch(() => {
        this.setData({
          imageDetecting: false,
          imageHint: '图片识别失败，请手动填写物品信息'
        });
      });
  },

  applyImageRecognition(result) {
    const itemName = result.itemName || result.title || (result.category && result.category !== '其他' ? result.category : '');
    const nextForm = Object.assign({}, this.data.form);
    let didAutoFillDescription = false;

    if (result.fileId) {
      nextForm.imageFileId = result.fileId;
      nextForm.imageUrls = [result.fileId];
    }
    if (!nextForm.title && itemName) {
      nextForm.title = itemName;
    }
    if (result.category) {
      nextForm.category = result.category;
    }
    if (result.aiTags && result.aiTags.length) {
      nextForm.aiTags = result.aiTags;
    } else if (result.category) {
      nextForm.aiTags = ['图片识别', result.category];
    }
    if (nextForm.type === 'found') {
      const currentDescription = (nextForm.description || '').trim();
      if (!currentDescription || this.data.descriptionAutoFilled) {
        nextForm.description = result.description || buildFoundDescription(nextForm);
        didAutoFillDescription = true;
      }
    }

    this.setData({
      form: nextForm,
      descriptionAutoFilled: didAutoFillDescription || this.data.descriptionAutoFilled,
      imageDetecting: false,
      imageHint: itemName ? `已识别：${itemName}` : '未能明确识别物品，请手动确认'
    });
  },

  updateFoundDescription(force) {
    if (this.data.form.type !== 'found') return;
    const currentDescription = (this.data.form.description || '').trim();
    if (!force && currentDescription && !this.data.descriptionAutoFilled) return;
    this.setData({
      'form.description': buildFoundDescription(this.data.form),
      descriptionAutoFilled: true
    });
  },

  fillFoundDescription() {
    if (this.data.form.type !== 'found') return;
    this.updateFoundDescription(true);
    wx.showToast({ title: '已自动填充', icon: 'success' });
  },

  submit() {
    if (!this.data.form.imageUrls.length && !this.data.form.category) {
      wx.showToast({ title: '请上传图片或选择分类', icon: 'none' });
      return;
    }
    const item = createItem(this.data.form);
    wx.showToast({ title: '发布成功', icon: 'success' });
    this.setData({
      form: initialForm(),
      locationKeyword: '',
      locations: searchLocations(),
      locationListTitle: '全部地点',
      descriptionAutoFilled: false
    });
    wx.navigateTo({ url: `/pages/detail/detail?id=${item._id}` });
  }
});
