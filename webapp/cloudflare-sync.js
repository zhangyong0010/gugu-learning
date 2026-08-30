/* 可选云端同步：仅在 Telegram Mini App 中启用；普通浏览器继续使用本地进度。 */
window.GUGU_CLOUD = (() => {
  const base = (window.GUGU_API_URL || '').replace(/\/$/, '');
  let token = sessionStorage.getItem('gugu-cloud-token') || '', timer;
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`GuGu 云端同步暂不可用 (${response.status})`);
    return response.json();
  };
  return {
    enabled: Boolean(base && window.Telegram?.WebApp?.initData),
    async load() {
      if (!base || !window.Telegram?.WebApp?.initData) return null;
      try {
        if (!token) { const session = await request('/api/session', { method: 'POST', body: JSON.stringify({ initData: window.Telegram.WebApp.initData }) }); token = session.token; sessionStorage.setItem('gugu-cloud-token', token); }
        return (await request('/api/state')).state;
      } catch (error) { console.warn('GuGu cloud sync unavailable', error.message); return null; }
    },
    save(state) {
      if (!token) return;
      clearTimeout(timer);
      timer = setTimeout(() => request('/api/state', { method: 'POST', body: JSON.stringify({ state }) }).catch(error => console.warn('GuGu cloud save failed', error.message)), 700);
    }
  };
})();
