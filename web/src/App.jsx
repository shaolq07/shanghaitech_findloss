import { useEffect, useMemo, useState } from 'react';
import { categories, locations } from './data.js';
import { clearUser, createItem, loadItems, loadUser, saveItems, saveUser } from './store.js';
import { classifyByText, findPotentialMatches, formatDate, getLocation } from './utils.js';
import { recognizeImageFile } from './vision.js';
import QQReviewPage from './QQReviewPage.jsx';
import { callLostfound, resolveCloudFileUrls } from './cloud.js';
import campusBoardImage from './assets/notice/campus-board.jpg';
import doneIcon from './assets/tabbar/done.png';
import doneActiveIcon from './assets/tabbar/done-active.png';
import foundIcon from './assets/tabbar/found.png';
import foundActiveIcon from './assets/tabbar/found-active.png';
import meIcon from './assets/tabbar/me.png';
import meActiveIcon from './assets/tabbar/me-active.png';
import searchIcon from './assets/tabbar/search.png';
import searchActiveIcon from './assets/tabbar/search-active.png';

const tabItems = [
  { key: 'found', text: '发现', icon: foundIcon, activeIcon: foundActiveIcon },
  { key: 'lost', text: '寻物', icon: searchIcon, activeIcon: searchActiveIcon },
  { key: 'returned', text: '已找到', icon: doneIcon, activeIcon: doneActiveIcon },
  { key: 'me', text: '我的', icon: meIcon, activeIcon: meActiveIcon }
];

function App() {
  if (window.location.pathname.replace(/\/+$/, '') === '/review') {
    return <QQReviewPage />;
  }
  const [items, setItems] = useState(() => loadItems());
  const [currentUser, setCurrentUser] = useState(() => loadUser());
  const [view, setView] = useState('found');
  const [activeCategory, setActiveCategory] = useState('全部');
  const [selectedId, setSelectedId] = useState(null);
  const [toast, setToast] = useState('');
  const [authPrompt, setAuthPrompt] = useState(null);
  const [cloudSync, setCloudSync] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    async function loadCloudItems() {
      try {
        const data = await callLostfound('listItems', {
          filters: { status: 'active', limit: 50 }
        });
        const fileIds = (data.items || []).flatMap((item) => [
          ...(item.imageFileIds || []),
          ...(item.imageUrls || []).filter((url) => /^cloud:\/\//i.test(url))
        ]);
        const imageUrls = await resolveCloudFileUrls(fileIds);
        const cloudItems = (data.items || []).map((item) => mapCloudItem(item, imageUrls));
        if (cancelled) return;
        setItems((current) => {
          const cloudIds = new Set(cloudItems.map((item) => item.id));
          return [...cloudItems, ...current.filter((item) => !cloudIds.has(item.id))];
        });
        setCloudSync('ok');
      } catch {
        if (!cancelled) setCloudSync('offline');
      }
    }
    loadCloudItems();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveItems(items);
  }, [items]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const stats = useMemo(() => {
    const active = items.filter((item) => item.status === 'active');
    return {
      found: active.filter((item) => item.type === 'found').length,
      lost: active.filter((item) => item.type === 'lost').length,
      returned: items.filter((item) => item.status === 'returned').length,
      total: items.length,
      active: active.length
    };
  }, [items]);

  const selectedItem = items.find((item) => item.id === selectedId);

  function openDetail(id) {
    setSelectedId(id);
    setView('detail');
  }

  function openTab(key) {
    setActiveCategory('全部');
    setView(key);
  }

  function requireAuth(actionLabel, onAuthed) {
    if (currentUser) {
      onAuthed(currentUser);
      return;
    }
    setAuthPrompt({ actionLabel, onAuthed });
  }

  function openPublish(type = 'found') {
    requireAuth(type === 'lost' ? '发布寻物' : '发布招领', () => {
      setView(type === 'lost' ? 'publish-lost' : 'publish-found');
    });
  }

  function publishItem(payload) {
    const nextItem = createItem({
      ...payload,
      ownerName: currentUser?.nickName || payload.ownerName,
      ownerContact: currentUser?.contact || '',
      title: payload.title || (payload.type === 'lost' ? '未命名寻物' : '未命名招领'),
      description: payload.description || '暂无补充描述'
    });
    setItems((current) => [nextItem, ...current]);
    setSelectedId(nextItem.id);
    setView('detail');
    setToast(payload.type === 'lost' ? '已发布寻物' : '已发布招领');
  }

  function submitClaim(item) {
    requireAuth(item.type === 'lost' ? '提供线索' : '认领物品', (user) => {
      const claim = {
        id: `claim_${Date.now()}`,
        userId: user.id,
        nickName: user.nickName,
        contact: user.contact,
        createdAt: new Date().toISOString()
      };
      setItems((current) => current.map((entry) => (
        entry.id === item.id
          ? { ...entry, claims: [...(entry.claims || []), claim] }
          : entry
      )));
      setToast(item.type === 'lost' ? '线索已提交' : '认领申请已提交');
    });
  }

  function handleAuthSubmit(user) {
    saveUser(user);
    setCurrentUser(user);
    const pending = authPrompt?.onAuthed;
    setAuthPrompt(null);
    setToast('已登录');
    if (pending) window.setTimeout(() => pending(user), 0);
  }

  function logout() {
    clearUser();
    setCurrentUser(null);
    setToast('已退出登录');
  }

  function updateProfile(profile) {
    requireAuth('保存个人资料', (user) => {
      const nextUser = {
        ...user,
        nickName: profile.nickName.trim() || user.nickName,
        contact: profile.emailPrefix.trim()
          ? `${profile.emailPrefix.trim()}@shanghaitech.edu.cn`
          : user.contact
      };
      saveUser(nextUser);
      setCurrentUser(nextUser);
      setToast('资料已保存');
    });
  }

  function addComment(item, content) {
    const text = content.trim();
    if (!text) return;
    requireAuth('提交线索', (user) => {
      const comment = {
        id: `comment_${Date.now()}`,
        authorName: user.nickName,
        content: text,
        createdAt: new Date().toISOString()
      };
      setItems((current) => current.map((entry) => (
        entry.id === item.id
          ? { ...entry, comments: [...(entry.comments || []), comment] }
          : entry
      )));
      setToast('线索已发送');
    });
  }

  function reportItem(item) {
    requireAuth('举报内容', () => {
      setItems((current) => current.map((entry) => (
        entry.id === item.id ? { ...entry, reported: true } : entry
      )));
      setToast('举报已记录，感谢维护校园互助环境');
    });
  }

  function markReturned(id) {
    setItems((current) => current.map((item) => (
      item.id === id
        ? { ...item, status: 'returned', returnedAt: new Date().toISOString() }
        : item
    )));
    setToast('已回家');
  }

  function undoReturned(id) {
    setItems((current) => current.map((item) => (
      item.id === id
        ? { ...item, status: 'active', returnedAt: null }
        : item
    )));
    setToast('已撤回');
  }

  const showTabBar = ['found', 'lost', 'returned', 'me'].includes(view);

  return (
    <main className="app-root">
      {view === 'found' && (
        <FoundPage
          items={items}
          activeCategory={activeCategory}
          setActiveCategory={setActiveCategory}
          total={stats.found}
          cloudSync={cloudSync}
          onPublish={() => openPublish('found')}
          onOpen={openDetail}
        />
      )}

      {view === 'lost' && (
        <LostPage
          items={items}
          activeCategory={activeCategory}
          setActiveCategory={setActiveCategory}
          total={stats.lost}
          onPublish={() => openPublish('lost')}
          onOpen={openDetail}
        />
      )}

      {view === 'returned' && (
        <ReturnedPage
          items={items}
          total={stats.returned}
          onOpen={openDetail}
        />
      )}

      {view === 'me' && (
        <MePage
          items={items}
          stats={stats}
          currentUser={currentUser}
          onPublish={() => openPublish('found')}
          onOpen={openDetail}
          onMarkReturned={markReturned}
          onUndoReturned={undoReturned}
          onLogout={logout}
          onSaveProfile={updateProfile}
        />
      )}

      {view.startsWith('publish') && (
        <PublishPage
          initialType={view === 'publish-lost' ? 'lost' : 'found'}
          items={items}
          currentUser={currentUser}
          onCancel={() => openTab(view === 'publish-lost' ? 'lost' : 'found')}
          onSubmit={publishItem}
        />
      )}

      {view === 'detail' && selectedItem && (
        <DetailPage
          item={selectedItem}
          items={items}
          onBack={() => openTab(selectedItem.status === 'returned' ? 'returned' : selectedItem.type)}
          onClaim={() => submitClaim(selectedItem)}
          onContact={() => requireAuth('联系发布人', () => setToast(
            selectedItem.ownerContact
              ? `发布人联系方式：${selectedItem.ownerContact}`
              : '发布人暂未留下公开联系方式，请提交认领或线索申请'
          ))}
          onComment={(content) => addComment(selectedItem, content)}
          onReport={() => reportItem(selectedItem)}
          onMarkReturned={() => markReturned(selectedItem.id)}
          onUndoReturned={() => undoReturned(selectedItem.id)}
        />
      )}

      {showTabBar && <TabBar view={view} onChange={openTab} />}
      {authPrompt && (
        <AuthModal
          actionLabel={authPrompt.actionLabel}
          onClose={() => setAuthPrompt(null)}
          onSubmit={handleAuthSubmit}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

function FoundPage({ items, activeCategory, setActiveCategory, total, cloudSync, onPublish, onOpen }) {
  const list = filterItems(items, 'found', 'active', activeCategory);
  const qqItems = items.filter((item) => item.type === 'found' && item.source?.channel === 'QQ群');
  const qqPhotoCount = qqItems.reduce(
    (count, item) => count + (item.images?.length || (item.image ? 1 : 0)),
    0
  );
  return (
    <section className="page found-page">
      <div className="board-head">
        <div>
          <h1 className="app-title">校园公告板</h1>
          <p className="app-subtitle">上海科技大学 · 失物招领平台</p>
        </div>
      </div>

      <button className="notice-banner" type="button" onClick={onPublish}>
        <div className="notice-copy">
          <strong className="notice-title">拾金不昧，传递温暖</strong>
          <span className="notice-subtitle">如遇失物，请及时发布招领信息</span>
        </div>
        <img className="notice-image" src={campusBoardImage} alt="" />
      </button>

      <div className="qq-import-card" aria-label={`QQ群发现已同步 ${qqItems.length} 条信息、${qqPhotoCount} 张照片`}>
        <div className="qq-import-head">
          <div>
            <span className="qq-import-kicker">QQ群发现 · 731332881</span>
            <strong className="qq-import-title">群聊线索已同步到官网</strong>
          </div>
          <span className={`qq-sync-badge ${cloudSync === 'offline' ? 'offline' : ''}`}>
            {cloudSync === 'loading' ? '连接中' : cloudSync === 'ok' ? '云端已连接' : '等待云端'}
          </span>
        </div>
        <div className="qq-import-stats">
          <span><strong>{qqItems.length}</strong> 条招领</span>
          <span><strong>{qqPhotoCount}</strong> 张照片</span>
          <span>审核通过后公开</span>
        </div>
      </div>

      <CategoryBar value={activeCategory} onChange={setActiveCategory} tone="found" />

      {list.length > 0 && (
        <div className="section-bar">
          <div>
            <h2 className="list-title">近期拾到 · {total} 条</h2>
            <p className="list-subtitle">按最新发布排序</p>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div className="empty">暂时没有招领信息</div>
      ) : (
        <FeedPanel items={list} kind="found" onOpen={onOpen} />
      )}

      <div className="safety-note">
        <span className="shield-dot" />
        <span>温馨提示：请勿发布他人隐私信息，招领成功后请及时下架。</span>
      </div>

      <PublishFab tone="found" label="发布招领" onClick={onPublish} />
    </section>
  );
}

function LostPage({ items, activeCategory, setActiveCategory, total, onPublish, onOpen }) {
  const list = filterItems(items, 'lost', 'active', activeCategory);
  return (
    <section className="page lost-page">
      <div className="board-head">
        <div>
          <h1 className="app-title">寻物登记</h1>
          <p className="app-subtitle">丢失物品后，先登记线索再等待匹配提醒</p>
        </div>
      </div>

      <button className="notice-banner lost" type="button" onClick={onPublish}>
        <img className="notice-image" src={campusBoardImage} alt="" />
        <div className="notice-copy">
          <strong className="notice-title">丢了东西，先留下线索</strong>
          <span className="notice-subtitle">{total} 条寻物正在等待匹配</span>
        </div>
      </button>

      <CategoryBar value={activeCategory} onChange={setActiveCategory} tone="lost" />

      {list.length > 0 && (
        <div className="section-bar">
          <div>
            <h2 className="list-title">正在寻找 · {total} 条</h2>
            <p className="list-subtitle">同学发布的寻物线索</p>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div className="empty">暂时没有寻物信息</div>
      ) : (
        <FeedPanel items={list} kind="lost" onOpen={onOpen} />
      )}

      <PublishFab tone="lost" label="发布寻物" onClick={onPublish} />
    </section>
  );
}

function ReturnedPage({ items, total, onOpen }) {
  const list = items
    .filter((item) => item.status === 'returned')
    .sort((a, b) => new Date(b.returnedAt || b.createdAt) - new Date(a.returnedAt || a.createdAt));

  return (
    <section className="page returned-page">
      <div className="board-head">
        <h1 className="app-title">已找到</h1>
        <p className="app-subtitle">归还成功的物品会留在这里，避免重复认领。</p>
      </div>

      <div className="summary-card">
        <strong className="summary-number">{total}</strong>
        <span className="summary-label">件物品已经回家</span>
      </div>

      {list.length === 0 ? (
        <div className="empty">还没有已找到记录</div>
      ) : (
        <div className="feed-panel">
          {list.map((item) => (
            <button key={item.id} className="found-row" type="button" onClick={() => onOpen(item.id)}>
              <span className="badge">已回家</span>
              <span className="item-copy">
                <strong className="title">{item.title}</strong>
                <span className="meta">{item.category}{locationText(item) ? ` · ${locationText(item)}` : ''}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function MePage({
  items,
  stats,
  currentUser,
  onPublish,
  onOpen,
  onMarkReturned,
  onUndoReturned,
  onLogout,
  onSaveProfile
}) {
  const [profile, setProfile] = useState({
    nickName: currentUser?.nickName || '校内用户',
    emailPrefix: currentUser?.contact ? currentUser.contact.replace('@shanghaitech.edu.cn', '') : ''
  });
  const shownItems = items.slice(0, 8);
  const displayName = currentUser?.nickName || profile.nickName || '校内用户';
  const avatarText = displayName.slice(0, 1);

  return (
    <section className="page me-page">
      <div className="profile-hero">
        <div className="hero-topline">
          <span className="hero-label">个人中心</span>
          <span className="hero-state">校内互助账号</span>
        </div>
        <div className="profile-main">
          <div className="avatar">{avatarText}</div>
          <div className="identity">
            <h1 className="name">{displayName}</h1>
            {currentUser?.contact && <p className="subtitle">{currentUser.contact}</p>}
          </div>
        </div>
        <div className="hero-badge">
          <span>上科大失物招领</span>
          <span>校园失物互助平台</span>
        </div>
      </div>

      <div className="stats-grid">
        <StatCard value={stats.total} label="全部发布" />
        <StatCard value={stats.active} label="进行中" />
        <StatCard value={stats.returned} label="已找回" />
      </div>

      <div className="card profile-form">
        <div className="section-head">
          <div>
            <span className="section-kicker">个人资料</span>
            <h2 className="form-title">校园账号</h2>
          </div>
          <span className="section-note">校内联系信息</span>
        </div>
        <input
          className="profile-input"
          aria-label="昵称"
          placeholder="昵称"
          value={profile.nickName}
          onChange={(event) => setProfile((current) => ({ ...current, nickName: event.target.value }))}
        />
        <div className="email-edit">
          <input
            className="email-prefix"
            aria-label="上科大邮箱前缀"
            placeholder="邮箱前缀"
            type="text"
            value={profile.emailPrefix}
            onChange={(event) => setProfile((current) => ({ ...current, emailPrefix: event.target.value }))}
          />
          <span className="email-domain">@shanghaitech.edu.cn</span>
        </div>
        <button className="button-primary save-profile" type="button" onClick={() => onSaveProfile(profile)}>保存资料</button>
        {currentUser && (
          <button className="button-secondary logout-button" type="button" onClick={onLogout}>退出登录</button>
        )}
      </div>

      <div className="quick-actions">
        <div className="quick-card secondary">
          <strong className="quick-title">校内互助</strong>
          <span className="quick-subtitle">仅展示必要联系信息</span>
        </div>
        <button className="quick-card primary" type="button" onClick={onPublish}>
          <strong className="quick-title">继续发布</strong>
          <span className="quick-subtitle">上传线索或寻物</span>
        </button>
      </div>

      <div className="section-head list-head">
        <div>
          <span className="section-kicker">发布记录</span>
          <h2 className="form-title">我的发布</h2>
        </div>
      </div>

      {shownItems.length === 0 ? (
        <div className="empty-panel">
          <div className="empty-mark">+</div>
          <strong className="empty-title">还没有发布过线索</strong>
          <span className="empty-copy">发布招领或寻物后，会在这里统一管理状态。</span>
        </div>
      ) : shownItems.map((item) => (
        <div key={item.id} className="card mine-card">
          <button className="item-content" type="button" onClick={() => onOpen(item.id)}>
            <span className="item-row">
              <span className={`type-pill ${item.type}`}>{item.type === 'lost' ? '寻物' : '招领'}</span>
              <span className="status-text">{item.status === 'returned' ? '已回家' : '进行中'}</span>
            </span>
            <strong className="title">{item.title}</strong>
            <span className="meta">{itemMeta(item)}</span>
          </button>
          {item.status === 'active' ? (
            <button className="small-action" type="button" onClick={() => onMarkReturned(item.id)}>已回家</button>
          ) : (
            <button className="small-action secondary" type="button" onClick={() => onUndoReturned(item.id)}>撤回</button>
          )}
        </div>
      ))}
    </section>
  );
}

function PublishPage({ initialType, items, currentUser, onCancel, onSubmit }) {
  const [form, setForm] = useState({
    type: initialType,
    title: '',
    description: '',
    category: '',
    tags: [],
    visualDescription: '',
    rawPredictions: [],
    locationId: locations[0].id,
    image: '',
    ownerName: currentUser?.nickName || '校内用户'
  });
  const [classifying, setClassifying] = useState(false);
  const [modelError, setModelError] = useState('');
  const [aiProcessStage, setAiProcessStage] = useState('idle');
  const [aiExtractedText, setAiExtractedText] = useState('');

  useEffect(() => {
    const classification = classifyByText(`${form.title} ${form.description}`);
    if (!form.image && (!form.category || classification.confidence > 0)) {
      setForm((current) => ({
        ...current,
        category: classification.category,
        tags: classification.tags
      }));
    }
  }, [form.title, form.description]);

  const matches = useMemo(() => findPotentialMatches(form, items), [form, items]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function recognitionHint(nextForm = form) {
    return [nextForm.title, nextForm.description, nextForm.category, ...(nextForm.tags || [])].join(' ').trim();
  }

  function extractedText(data = {}) {
    return [data.category, ...(data.tags || [])]
      .filter((entry) => entry && !['其他', '待确认'].includes(entry))
      .slice(0, 4)
      .join('、') || '物品特征待确认';
  }

  async function chooseImage(file) {
    if (!file) return;
    setClassifying(true);
    setModelError('');
    setAiProcessStage('recognizing');
    setAiExtractedText('');
    try {
      const result = await recognizeImageFile(file, recognitionHint());
      const data = result.data || {};
      const nextExtractedText = extractedText(data);
      setForm((current) => ({
        ...current,
        image: result.image,
        title: current.title || data.title || data.category || '',
        description: current.description || data.description || data.visualDescription || '',
        category: data.category || current.category || '其他',
        tags: data.tags || [],
        visualDescription: data.visualDescription || data.description || '',
        rawPredictions: data.rawPredictions || []
      }));
      setAiExtractedText(nextExtractedText);
      setAiProcessStage('matching');
      if (result.warning) setModelError(result.warning);
    } catch (error) {
      setModelError(`图片识别失败：${error.message || '请手动填写或重新上传'}`);
      setAiProcessStage('error');
    } finally {
      setClassifying(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    onSubmit(form);
  }

  return (
    <section className="page publish-page">
      <div className="publish-hero">
        <div className="hero-copy">
          <span className="surface-eyebrow">{form.type === 'lost' ? '寻物登记' : '招领登记'}</span>
          <h1 className="surface-title">{form.type === 'lost' ? '先把线索留下' : '捡到物品，先贴到公告栏'}</h1>
          <p className="surface-subtitle">
            {form.type === 'lost'
              ? '描述物品和最后出现的位置，方便同学帮你留意。'
              : '照片可以后补；地点和分类越具体，越容易找到主人。'}
          </p>
        </div>
        <div className="hero-pin" aria-hidden="true">
          <span className="hero-pin-plus">+</span>
          <span>发布</span>
        </div>
      </div>

      <form className="publish-card" onSubmit={submit}>
        <div className="segmented" aria-label="发布类型">
          <button type="button" className={form.type === 'found' ? 'active' : ''} onClick={() => update('type', 'found')}>我捡到了</button>
          <button type="button" className={form.type === 'lost' ? 'active' : ''} onClick={() => update('type', 'lost')}>我丢了</button>
        </div>

        <label className="image-picker">
          {form.image ? (
            <img src={form.image} alt="待发布物品预览" />
          ) : (
            <span className="image-empty">
              <span className="image-plus">+</span>
              <span className="image-title">拍照或从相册选择</span>
              <span className="image-hint">没有照片也可以先发布</span>
            </span>
          )}
          <input type="file" accept="image/*" onChange={(event) => chooseImage(event.target.files?.[0])} />
        </label>

        {(classifying || aiProcessStage !== 'idle' || modelError || form.visualDescription) && (
          <RecognitionPanel
            classifying={classifying}
            stage={aiProcessStage}
            extractedText={aiExtractedText}
            type={form.type}
            error={modelError}
            visualDescription={form.visualDescription}
          />
        )}

        <div className="form-section">
          <span className="section-kicker">物品信息</span>
          <input className="field" aria-label="物品标题" placeholder="物品标题，可不填" value={form.title} onChange={(event) => update('title', event.target.value)} />
          <textarea className="field textarea" aria-label="物品描述" placeholder="补充描述，可不填" value={form.description} onChange={(event) => update('description', event.target.value)} />
        </div>

        <div className="form-section">
          <div className="section-head publish-section-head">
            <span className="section-kicker">物品分类</span>
            <span className="section-note">请选择最符合的类别</span>
          </div>
          {form.category && (
            <div className="ai-result">
              <span>当前分类：{form.category}</span>
              <button type="button" onClick={() => update('category', '')}>清除</button>
            </div>
          )}
          <CategoryBar
            value={form.category}
            onChange={(entry) => update('category', entry)}
            hideAll
            tone="found"
          />
        </div>

        <div className="form-section">
          <div className="section-head publish-section-head">
            <span className="section-kicker">地点</span>
            <span className="section-note">尽量选到楼栋或区域</span>
          </div>
          <div className="location-panel ok">
            <div className="location-head">
              <div>
                <strong className="location-title">{getLocation(form.locationId).name}</strong>
                <span className="location-subtitle">{getLocation(form.locationId).area}</span>
              </div>
            </div>
            <select className="field select-field" aria-label="失物地点" value={form.locationId} onChange={(event) => update('locationId', event.target.value)}>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
            <div className="location-confirm">
              <div className="location-confirm-row">
                <span>已选择：</span>
                <strong>{getLocation(form.locationId).name}</strong>
              </div>
              <div className="location-confirm-row">
                <span>地点区域：</span>
                <strong>{getLocation(form.locationId).area}</strong>
              </div>
              <p className="location-confirm-note">{getLocation(form.locationId).guide}</p>
            </div>
          </div>
        </div>

        {form.type === 'lost' && matches.length > 0 && (
          <div className="match-panel">
            <h2 className="match-title">可能是这几件</h2>
            {matches.map((item) => (
              <div key={item.id} className="match-item">
                <div>
                  <strong className="match-name">{item.title}</strong>
                  <span className="match-meta">{locationText(item)} · 相似度 {item.similarity}%</span>
                  <span className="match-reason">{item.reasons.join('、')}</span>
                </div>
                <span className="match-pill">查看</span>
              </div>
            ))}
          </div>
        )}

        <div className="publish-actions">
          <button className="button-secondary" type="button" onClick={onCancel}>取消</button>
          <button className="button-primary submit" type="submit">发布</button>
        </div>
      </form>
    </section>
  );
}

function PublishFab({ tone, label, onClick }) {
  return (
    <button className={`publish-fab ${tone}`} type="button" aria-label={label} onClick={onClick}>
      <span className="publish-fab-plus">+</span>
      <span className="publish-fab-label">发布</span>
    </button>
  );
}

function RecognitionPanel({ classifying, stage, extractedText, type, error, visualDescription }) {
  const target = type === 'lost' ? '历史招领' : '历史寻物';
  const steps = stage === 'error'
    ? [{ key: 'error', text: '图片识别失败，可手动填写或重新上传', status: 'error' }]
    : [
      {
        key: 'recognize',
        text: '正在识别物品特征',
        status: stage === 'recognizing' ? 'active' : 'done'
      },
      {
        key: 'extract',
        text: extractedText ? `已提取：${extractedText}` : '等待提取颜色、类别和细节',
        status: extractedText ? 'done' : 'pending'
      },
      {
        key: 'match',
        text: `正在匹配${target}`,
        status: stage === 'matching' ? 'active' : 'pending'
      }
    ];

  return (
    <div className="recognition-panel">
      <div className="ai-process-head">
        <span>识别建议</span>
        <span>{classifying ? '处理中' : stage === 'error' ? '需手动确认' : '已更新'}</span>
      </div>
      {steps.map((step) => (
        <div key={step.key} className={`ai-process-step ${step.status}`}>
          <span className="ai-step-dot" />
          <span className="ai-step-text">{step.text}</span>
        </div>
      ))}
      {visualDescription && <p className="model-desc">{visualDescription}</p>}
      {error && <p className={stage === 'error' ? 'model-error' : 'model-warning'}>{error}</p>}
    </div>
  );
}

function AuthModal({ actionLabel, onClose, onSubmit }) {
  const [mode, setMode] = useState('register');
  const [form, setForm] = useState({
    nickName: '',
    contact: '',
    password: ''
  });
  const [error, setError] = useState('');

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setError('');
  }

  function submit(event) {
    event.preventDefault();
    const contact = form.contact.trim();
    const nickName = form.nickName.trim();
    if (!contact) {
      setError('请填写上科大邮箱或联系方式');
      return;
    }
    if (mode === 'register' && !nickName) {
      setError('请填写昵称');
      return;
    }
    if (!form.password.trim()) {
      setError('请填写密码');
      return;
    }
    onSubmit({
      id: `user_${Date.now()}`,
      nickName: nickName || contact.split('@')[0] || '校内用户',
      contact,
      createdAt: new Date().toISOString()
    });
  }

  return (
    <div className="auth-backdrop" role="dialog" aria-modal="true" aria-label="登录或注册">
      <form className="auth-panel" onSubmit={submit}>
        <div className="auth-head">
          <div>
            <span className="auth-kicker">{actionLabel}</span>
            <h2>{mode === 'register' ? '注册校内账号' : '登录账号'}</h2>
            <p>登录后可发布信息、认领物品和提交线索。</p>
          </div>
          <button className="auth-close" type="button" aria-label="关闭" onClick={onClose}>×</button>
        </div>

        <div className="auth-switch" aria-label="登录注册切换">
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>注册</button>
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>登录</button>
        </div>

        {mode === 'register' && (
          <label className="auth-field">
            <span>昵称</span>
            <input value={form.nickName} placeholder="例如：图书馆同学" onChange={(event) => update('nickName', event.target.value)} />
          </label>
        )}

        <label className="auth-field">
          <span>联系方式</span>
          <input value={form.contact} placeholder="name@shanghaitech.edu.cn" onChange={(event) => update('contact', event.target.value)} />
        </label>

        <label className="auth-field">
          <span>密码</span>
          <input type="password" value={form.password} placeholder="请输入密码" onChange={(event) => update('password', event.target.value)} />
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button className="button-primary auth-submit" type="submit">
          {mode === 'register' ? '注册并继续' : '登录并继续'}
        </button>
      </form>
    </div>
  );
}

function DetailPage({ item, items, onBack, onClaim, onContact, onComment, onReport }) {
  const matches = findPotentialMatches(item, items);
  const location = getLocation(item.locationId);
  const claimCount = item.claims?.length || 0;
  const gallery = item.images?.length ? item.images : (item.image ? [item.image] : []);
  const [comment, setComment] = useState('');

  function submitComment() {
    if (!comment.trim()) return;
    onComment(comment);
    setComment('');
  }

  return (
    <section className="page detail-page">
      <button className="back-button" type="button" onClick={onBack}>返回</button>

      <div className={`detail-gallery ${gallery.length > 1 ? 'multi' : ''}`}>
        {gallery.length ? gallery.map((image, index) => (
          <figure className="detail-image" key={`${item.id}_photo_${index}`}>
            <img src={image} alt={`${item.title}，照片 ${index + 1}/${gallery.length}`} />
            <figcaption>照片 {index + 1}/{gallery.length}</figcaption>
          </figure>
        )) : (
          <div className="detail-image"><span>{item.category}</span></div>
        )}
      </div>

      <div className="card detail-card">
        <div className="detail-head">
          <div className="title-block">
            <span className="detail-kicker">{item.type === 'lost' ? '寻物详情' : '招领详情'}</span>
            <h1 className="title">{item.title}</h1>
          </div>
          <span className={`type-pill ${item.type}`}>{item.type === 'lost' ? '寻物中' : '招领中'}</span>
        </div>
        <p className="desc">{item.description}</p>
        <div className="tag-row">
          <span className="tag active">{item.category}</span>
          {(item.tags || []).filter((tag) => tag !== item.category).map((tag) => <span key={tag} className="tag">{tag}</span>)}
        </div>
      </div>

      {item.source?.channel === 'QQ群' && (
        <div className="card qq-source-card">
          <div className="qq-source-head">
            <div>
              <span className="qq-import-kicker">来自 QQ 群 · {item.source.groupId}</span>
              <strong>{item.source.authorAlias} · {formatDate(item.source.sentAt)}</strong>
            </div>
            <span className="qq-sync-badge">群聊原始线索</span>
          </div>
          <blockquote>“{item.source.message}”</blockquote>
          <div className="analysis-pending">
            <span className="analysis-dot" />
            <span>智能分析待同事接入；当前内容按群聊文字人工整理</span>
          </div>
          {item.privacyRedacted && <p className="privacy-note">照片中的姓名、学号或人像已做不可逆遮挡。</p>}
        </div>
      )}

      <div className="card location-card">
        <div className="location-heading">
          <div>
            <strong className="location-name">{location.name}</strong>
            <span className="muted">{location.area}</span>
          </div>
          <span className="location-badge">校内定位</span>
        </div>
        <div className="location-guide">{item.exactLocation || location.guide}</div>
        <p className="map-note">地图为辅助定位，具体位置以发布人选择的地点标记为准。</p>
      </div>

      <div className="action-grid">
        <button className="button-secondary" type="button" onClick={onContact}>联系发布人</button>
        {item.status === 'active' && (
          <button className="button-primary" type="button" onClick={onClaim}>
            {item.type === 'lost' ? '我有线索' : '我要认领'}
          </button>
        )}
        <button className="button-danger" type="button" onClick={onReport} disabled={item.reported}>
          {item.reported ? '已举报' : '举报'}
        </button>
      </div>
      {claimCount > 0 && (
        <p className="claim-note">{claimCount} 位同学已提交{item.type === 'lost' ? '线索' : '认领申请'}，请等待发布人确认。</p>
      )}

      {matches.length > 0 && (
        <>
          <h2 className="section-title">可能匹配</h2>
          <div className="feed-panel">
            {matches.map((match) => (
              <div key={match.id} className="found-row compact">
                <span className="badge">{match.similarity}%</span>
                <span className="item-copy">
                  <strong className="title">{match.title}</strong>
                  <span className="meta">{match.reasons.join('、')}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">评论</h2>
      {(item.comments || []).length ? (
        <div className="feed-panel">
          {item.comments.map((entry) => (
            <div className="found-row compact" key={entry.id}>
              <span className="item-copy">
                <strong className="title">{entry.authorName}</strong>
                <span className="meta">{entry.content}</span>
              </span>
            </div>
          ))}
        </div>
      ) : <div className="empty small">还没有评论，欢迎补充线索</div>}
      <div className="comment-box">
        <input aria-label="评论内容" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="写下线索或领取信息" />
        <button type="button" disabled={!comment.trim()} onClick={submitComment}>发送</button>
      </div>
    </section>
  );
}

function CategoryBar({ value, onChange, hideAll = false, tone = 'found' }) {
  const list = hideAll ? categories.filter((entry) => entry !== '全部') : categories;
  return (
    <div className={`category-bar ${tone}`}>
      {list.map((entry) => (
        <button
          key={entry}
          className={`tag ${value === entry ? 'active' : ''}`}
          type="button"
          onClick={() => onChange(entry)}
        >
          {entry}
        </button>
      ))}
    </div>
  );
}

function FeedPanel({ items, kind, onOpen }) {
  return (
    <div className={`feed-panel ${kind}`}>
      {items.map((item) => (
        <button key={item.id} className="item-row" type="button" onClick={() => onOpen(item.id)}>
          <ItemThumbnail item={item} kind={kind} />
          <span className="item-main">
            <span className="item-head">
              <strong className="item-title">{item.title}</strong>
              <span className={`type-pill ${kind === 'lost' ? 'lost' : 'found'}`}>{kind === 'lost' ? '寻物中' : '招领中'}</span>
            </span>
            <span className="item-desc">{item.description}</span>
            {item.source?.channel === 'QQ群' && (
              <span className="qq-row-source">
                <span>QQ群发现</span>
                <span>{item.source.authorAlias} · {formatDate(item.source.sentAt)}</span>
              </span>
            )}
            <span className="item-meta">
              <span className={`pin-dot ${kind === 'lost' ? 'lost' : ''}`} />
              <span>{locationText(item)}</span>
              <span className="tag light">{item.category}</span>
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function ItemThumbnail({ item, kind }) {
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setLoadFailed(false);
  }, [item.image]);

  const hasImage = Boolean(item.image) && !loadFailed;
  const photoCount = item.images?.length || 0;

  return (
    <span className={`image-box ${kind} ${hasImage ? 'has-image' : 'is-empty'}`}>
      {hasImage ? (
        <img
          src={item.image}
          alt={`${item.title}的物品照片`}
          onError={() => setLoadFailed(true)}
        />
      ) : (
        <span className="image-placeholder" aria-label="暂无物品照片">
          <span aria-hidden="true">◇</span>
          <small>暂无照片</small>
        </span>
      )}
      {hasImage && photoCount > 1 && <span className="photo-count">{photoCount} 张</span>}
    </span>
  );
}

function TabBar({ view, onChange }) {
  return (
    <nav className="tab-bar" aria-label="主导航">
      {tabItems.map((item) => {
        const active = view === item.key;
        return (
          <button key={item.key} type="button" className={active ? 'active' : ''} onClick={() => onChange(item.key)}>
            <img src={active ? item.activeIcon : item.icon} alt="" />
            <span>{item.text}</span>
          </button>
        );
      })}
    </nav>
  );
}

function StatCard({ value, label }) {
  return (
    <div className="stat-card">
      <strong className="stat-value">{value}</strong>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function filterItems(items, type, status, category) {
  return items
    .filter((item) => item.type === type && item.status === status)
    .filter((item) => category === '全部' || item.category === category)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function locationText(item) {
  return getLocation(item.locationId)?.name || '';
}

function itemMeta(item) {
  const date = formatDate(item.createdAt);
  const location = locationText(item);
  return [item.category, location, date].filter(Boolean).join(' · ');
}

function cloudDate(value) {
  if (!value) return new Date().toISOString();
  const candidate = (typeof value === 'string' || typeof value === 'number')
    ? value
    : value.$date || value.date || value.value || value.seconds;
  if (value.seconds) return new Date(value.seconds * 1000).toISOString();
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function mapCloudItem(item, resolvedUrls) {
  const imageSources = Array.from(new Set([
    ...(item.imageFileIds || []),
    ...(item.imageUrls || [])
  ].filter(Boolean)));
  const images = imageSources
    .map((fileId) => resolvedUrls[fileId] || (/^https:\/\//i.test(fileId) ? fileId : ''))
    .filter(Boolean);
  return {
    id: item._id,
    type: item.type || 'found',
    title: item.title || '未命名线索',
    description: item.description || '暂无补充描述',
    category: item.category || '其他',
    tags: item.aiTags || item.semanticTags || [],
    image: images[0] || '',
    images,
    locationId: item.locationId || '',
    exactLocation: item.locationDetail || item.locationName || '',
    ownerName: item.ownerName || '校园用户',
    status: item.status || 'active',
    createdAt: cloudDate(item.createdAt),
    privacyRedacted: Boolean(item.privacyRedacted),
    source: item.source || null,
    cloudSynced: true
  };
}

export default App;
