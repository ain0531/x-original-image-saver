// Use X's own controls; this button never starts an image download.
(() => {
  const instance = globalThis as any;
  if (instance.__xOriginalPostButtons) return;
  instance.__xOriginalPostButtons = true;
  const marker = 'data-x-original-save';
  let stopped = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const busy = new WeakSet<Element>();
  const observer = new MutationObserver(() => schedule());
  const timer = setInterval(() => { if (!enabled()) cleanup(); }, 1000);
  function enabled(): boolean {
    try { return !!chrome.runtime.id && !!chrome.runtime.getManifest(); }
    catch { return false; }
  }
  function cleanup(): void {
    stopped = true; observer.disconnect(); clearInterval(timer);
    if (scheduled !== undefined) clearTimeout(scheduled);
    document.querySelectorAll(`[${marker}]`).forEach(node => node.remove());
    document.removeEventListener('visibilitychange', check);
  }
  function check(): void { if (!enabled()) cleanup(); else schedule(); }
  function schedule(): void {
    if (stopped || scheduled !== undefined) return;
    scheduled = setTimeout(() => { scheduled = undefined; scan(); }, 80);
  }
  function postId(article: Element): string | undefined {
    const link = Array.from(article.querySelectorAll('a[href]')).find(link => link.querySelector('time') && link.closest('article') === article);
    if (!link) return;
    try { return new URL((link as HTMLAnchorElement).href, location.href).pathname.match(/\/status\/(\d+)/)?.[1]; }
    catch { return; }
  }
  function control(article: Element, testId: string): HTMLElement | undefined {
    return Array.from(article.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)).find(node => node.closest('article') === article);
  }
  function refresh(button: HTMLButtonElement, article: Element): void {
    const active = !!control(article, 'unlike') && !!control(article, 'removeBookmark');
    const pressed = String(active);
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    const text = busy.has(article) ? '設定中...' : active ? '特別保存済み' : '特別保存';
    if (button.textContent !== text) button.textContent = text;
    button.disabled = busy.has(article);
  }
  async function activateControl(article: Element, id: string, off: string, on: string, label: string): Promise<void> {
    if (!enabled() || !article.isConnected || postId(article) !== id) throw new Error('投稿が変わりました。再度お試しください。');
    if (control(article, on)) return;
    const target = control(article, off);
    if (!target || target.getAttribute('aria-disabled') === 'true' || (target as HTMLButtonElement).disabled) throw new Error(`${label}の操作ボタンを確認できません。`);
    target.click();
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      if (!enabled() || !article.isConnected || postId(article) !== id) throw new Error('投稿が変わりました。再度お試しください。');
      if (control(article, on)) return;
    }
    throw new Error(`${label}の反映を確認できません。状態を確認して再試行してください。`);
  }
  async function save(button: HTMLButtonElement, status: HTMLElement, article: Element, id: string): Promise<void> {
    if (!enabled()) { cleanup(); return; }
    if (postId(article) !== id) { schedule(); return; }
    busy.add(article); refresh(button, article); status.textContent = '';
    try {
      const errors: string[] = [];
      for (const [off, on, label] of [['like', 'unlike', 'いいね'], ['bookmark', 'removeBookmark', 'ブックマーク']]) {
        try { await activateControl(article, id, off, on, label); }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
      if (postId(article) !== id) return;
      status.textContent = errors.length ? errors.join(' ') : 'いいね・ブックマーク済み';
    } catch (error) {
      if (!enabled()) { cleanup(); return; }
      if (postId(article) === id) status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy.delete(article); refresh(button, article);
    }
  }
  function scan(): void {
    if (!enabled()) { cleanup(); return; }
    const root = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
    if (!root) return;
    for (const article of Array.from(root.querySelectorAll('article'))) {
      const id = postId(article);
      const group = Array.from(article.querySelectorAll('[role="group"]')).filter(node => node.closest('article') === article && node.querySelector('[data-testid="reply"], [data-testid="like"], [data-testid="unlike"]')).pop();
      const existing = Array.from(article.querySelectorAll(`[${marker}]`)).find(node => node.closest('article') === article);
      if (existing && existing.getAttribute(marker) === id && group) {
        if (existing.parentElement !== group) group.appendChild(existing);
        refresh(existing.querySelector('button')!, article); continue;
      }
      existing?.remove();
      if (!id || !group) continue;
      const row = document.createElement('div'); row.setAttribute(marker, id);
      row.style.cssText = 'display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;font:inherit;color:inherit;';
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '特別保存';
      button.setAttribute('aria-label', 'この投稿にいいねとブックマークを付ける');
      button.style.cssText = 'border:1px solid currentColor;border-radius:16px;background:transparent;color:inherit;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer;';
      const status = document.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.style.cssText = 'font-size:12px;overflow-wrap:anywhere;';
      row.append(button, status);
      row.addEventListener('click', event => event.stopPropagation());
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!button.disabled) void save(button, status, article, id); });
      group.appendChild(row); refresh(button, article);
    }
  }
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'] });
  document.addEventListener('visibilitychange', check);
  scan();
})();
