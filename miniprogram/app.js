const { ensureSeedData, isRegistered } = require('./utils/store');

const CLOUD_ENV = 'skd-d2gvbeo5c6227bf73';
const MODEL_API_URL = 'http://127.0.0.1:8787/lostfound-vision';
const INDOOR_API_URL = 'http://127.0.0.1:8787/indoor-location';

App({
  globalData: {
    user: null,
    cloudReady: false,
    cloudEnv: CLOUD_ENV,
    modelApiUrl: MODEL_API_URL,
    indoorApiUrl: INDOOR_API_URL
  },

  onLaunch() {
    ensureSeedData();

    if (wx.cloud) {
      try {
        wx.cloud.init({
          env: CLOUD_ENV,
          traceUser: true
        });
        this.globalData.cloudReady = true;
      } catch (error) {
        this.globalData.cloudReady = false;
      }
    }

    setTimeout(() => {
      if (!isRegistered()) {
        wx.reLaunch({ url: '/pages/auth/auth' });
      }
    }, 200);
  }
});
