import { useEffect, useMemo, useState } from 'react';
import { callLostfound, readableCloudError, resolveCloudFileUrls } from './cloud.js';

const TOKEN_KEY = 'lockmyitem_qq_review_token';
const riskLabels = {
  IMAGE_REVIEW_REQUIRED: '需核对图片隐私',
  PHONE_NUMBER: '可能含手机号',
  QQ_NUMBER: '可能含 QQ 号',
  IDENTITY_NUMBER: '可能含证件号',
  POSSIBLE_PERSONAL_DATA: '可能含个人信息'
};

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value || '')
    : new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
}

function LoginPanel({ onLogin, error, busy }) {
  const [token, setToken] = useState('');
  return (
    <main className="review-login-shell">
      <section className="review-login-card">
        <span className="review-eyebrow">LOCKMYITEM · 内部工具</span>
        <h1>QQ 线索审核台</h1>
        <p>群消息会先停在这里。核对物品、地点和隐私后，才会出现在公开官网。</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (token.trim()) onLogin(token.trim());
        }}>
          <label htmlFor="review-token">管理员审核密钥</label>
          <input
            id="review-token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="输入云函数中配置的审核密钥"
          />
          {error && <p className="review-error" role="alert">{error}</p>}
          <button type="submit" disabled={busy || !token.trim()}>
            {busy ? '正在验证…' : '进入审核队列'}
          </button>
        </form>
      </section>
    </main>
  );
}

function ReviewCard({ item, token, onDone }) {
  const [draft, setDraft] = useState(item.draft || {});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function decide(decision) {
    setBusy(decision);
    setError('');
    try {
      await callLostfound('reviewQQItem', {
        adminToken: token,
        queueId: item._id,
        decision,
        draft
      }, 45000);
      onDone(item._id, decision);
    } catch (nextError) {
      setError(readableCloudError(nextError, '审核失败'));
    } finally {
      setBusy('');
    }
  }

  return (
    <article className="review-card">
      <header className="review-card-head">
        <div>
          <span className="review-source">QQ群 {item.groupId}</span>
          <strong>{item.senderAlias || '群成员'}</strong>
        </div>
        <time>{formatTime(item.sentAt)}</time>
      </header>

      <blockquote>{item.content || '（仅图片消息）'}</blockquote>

      {!!item.resolvedImages?.length && (
        <div className="review-images">
          {item.resolvedImages.map((url, index) => (
            <a href={url} target="_blank" rel="noreferrer" key={url}>
              <img src={url} alt={`待审核群聊图片 ${index + 1}`} />
            </a>
          ))}
        </div>
      )}

      {!!item.riskFlags?.length && (
        <div className="review-risks" aria-label="隐私风险">
          {item.riskFlags.map((risk) => (
            <span key={risk}>{riskLabels[risk] || risk}</span>
          ))}
        </div>
      )}

      <div className="review-form-grid">
        <label>
          发布类型
          <select value={draft.type || 'found'} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
            <option value="found">招领</option>
            <option value="lost">寻物</option>
          </select>
        </label>
        <label>
          分类
          <select value={draft.category || '其他'} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
            {['证件', '电子产品', '书本资料', '衣物', '钥匙', '校园卡', '雨伞', '水杯', '其他'].map((entry) => (
              <option key={entry} value={entry}>{entry}</option>
            ))}
          </select>
        </label>
        <label className="review-wide">
          官网标题
          <input value={draft.title || ''} maxLength={80} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </label>
        <label className="review-wide">
          公开描述
          <textarea value={draft.description || ''} maxLength={1000} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        </label>
        <label className="review-wide">
          地点补充
          <input value={draft.locationDetail || ''} maxLength={300} onChange={(event) => setDraft({ ...draft, locationDetail: event.target.value })} placeholder="例如：教学中心 304 讲台" />
        </label>
        <label className="review-check review-wide">
          <input type="checkbox" checked={Boolean(draft.privacyRedacted)} onChange={(event) => setDraft({ ...draft, privacyRedacted: event.target.checked })} />
          <span>公开版本已完成隐私脱敏</span>
        </label>
      </div>

      {error && <p className="review-error" role="alert">{error}</p>}
      <footer className="review-actions">
        <button className="review-reject" type="button" disabled={Boolean(busy)} onClick={() => decide('reject')}>
          {busy === 'reject' ? '处理中…' : '驳回'}
        </button>
        <button className="review-approve" type="button" disabled={Boolean(busy) || !draft.title?.trim()} onClick={() => decide('approve')}>
          {busy === 'approve' ? '正在发布…' : '通过并发布'}
        </button>
      </footer>
    </article>
  );
}

export default function QQReviewPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('pending');
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadQueue(nextToken = token, nextStatus = status) {
    setLoading(true);
    setError('');
    try {
      const data = await callLostfound('listQQReviewQueue', {
        adminToken: nextToken,
        status: nextStatus,
        limit: 100
      });
      const imageIds = data.items.flatMap((item) => (item.images || []).map((image) => image.fileId));
      const urls = await resolveCloudFileUrls(imageIds);
      setItems(data.items.map((item) => ({
        ...item,
        resolvedImages: (item.images || []).map((image) => urls[image.fileId]).filter(Boolean)
      })));
      sessionStorage.setItem(TOKEN_KEY, nextToken);
      setToken(nextToken);
    } catch (nextError) {
      setError(readableCloudError(nextError, '无法读取审核队列'));
      if (nextError?.code === 'FORBIDDEN') {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken('');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) loadQueue(token, status);
    // Token and status changes intentionally trigger a fresh cloud query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const pendingCount = useMemo(() => status === 'pending' ? items.length : 0, [items, status]);

  if (!token) return <LoginPanel onLogin={(value) => loadQueue(value, status)} error={error} busy={loading} />;

  return (
    <main className="review-shell">
      <header className="review-topbar">
        <div>
          <span className="review-eyebrow">QQ群 → 官网</span>
          <h1>线索审核队列</h1>
          <p>生产群 731332881 · {pendingCount} 条待处理</p>
        </div>
        <div className="review-top-actions">
          <a href="/">返回官网</a>
          <button type="button" onClick={() => loadQueue(token, status)}>刷新</button>
        </div>
      </header>

      <nav className="review-tabs" aria-label="审核状态">
        {[
          ['pending', '待审核'],
          ['approved', '已发布'],
          ['rejected', '已驳回']
        ].map(([value, label]) => (
          <button type="button" className={status === value ? 'active' : ''} key={value} onClick={() => setStatus(value)}>
            {label}
          </button>
        ))}
      </nav>

      {notice && <p className="review-notice" role="status">{notice}</p>}
      {error && <p className="review-error review-page-error" role="alert">{error}</p>}
      {loading ? (
        <div className="review-empty">正在从云端读取审核队列…</div>
      ) : items.length ? (
        <section className="review-list">
          {items.map((item) => (
            <ReviewCard
              key={item._id}
              item={item}
              token={token}
              onDone={(id, decision) => {
                setItems((current) => current.filter((entry) => entry._id !== id));
                setNotice(decision === 'approve' ? '已通过并发布到官网。' : '已驳回，不会公开。');
              }}
            />
          ))}
        </section>
      ) : (
        <div className="review-empty">
          <strong>{status === 'pending' ? '队列已清空' : '暂无记录'}</strong>
          <span>{status === 'pending' ? '新的群消息到达后会自动出现在这里。' : '切换其他状态查看审核记录。'}</span>
        </div>
      )}
    </main>
  );
}
