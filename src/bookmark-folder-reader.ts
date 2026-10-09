// MAIN world: use the logged-in Web client's configuration. Never export credentials.
(() => {
  const host = window as any;
  if (host.__xOriginalBookmarkFolders?.version === 6) return;
  const request = window.fetch.bind(window);
  type Config = { url: string; variables: Record<string, unknown>; features?: Record<string, boolean> };
  let headers: Headers | undefined;
  let account = '';
  const configs = new Map<string, Config>();
  const nativeBookmarks = new Map<string, { account: string; at: number; finished: Promise<void> }>();
  const publicTemplates = () => Object.fromEntries([...configs].map(([operation, config]) => [operation, { url: config.url, variables: typeof config.variables.count === 'number' ? { count: config.variables.count } : {}, features: config.features }]));
  const cookie = (name: string) => document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1) ?? '';
  const session = () => cookie('twid') + ':' + cookie('ct0');
  const userId = () => { try { return /^"?u=(\d+)"?$/.exec(decodeURIComponent(cookie('twid')))?.[1]; } catch { return; } };
  const reset = () => { const next = session(); if (next !== account) { account = next; headers = undefined; configs.clear(); nativeBookmarks.clear(); } };
  function bookmarkTicket(raw: string, body: unknown) {
    if (operationOf(raw) !== 'CreateBookmark' || typeof body !== 'string') return;
    try {
      const id = JSON.parse(body)?.variables?.tweet_id;
      if (typeof id !== 'string' || !/^\d+$/.test(id)) return;
      reset();
      let finish!: () => void, fail!: (error: Error) => void;
      const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      void finished.catch(() => {});
      nativeBookmarks.set(id, { account: session(), at: Date.now(), finished });
      return { finish, fail };
    } catch { return; }
  }
  const operationOf = (raw: string) => {
    try { const url = new URL(raw, location.href); return url.origin === location.origin ? url.pathname.match(/^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/([A-Za-z0-9_]+)$/)?.[1] : undefined; }
    catch { return; }
  };
  function capture(raw: string, captured: Headers, body?: unknown): void {
    reset();
    const operation = operationOf(raw);
    if (!operation || !cookie('ct0') || captured.get('x-csrf-token') !== cookie('ct0') || !captured.get('authorization')?.startsWith('Bearer ')) return;
    headers = new Headers(captured);
    // Transaction IDs are request-specific; never reuse one for a different operation.
    headers.delete('x-client-transaction-id');
    if (!['BookmarkFoldersSlice', 'bookmarkTweetToFolder'].includes(operation)) return;
    try {
      const url = new URL(raw, location.href);
      const payload = typeof body === 'string' ? JSON.parse(body) : undefined;
      const variables = payload?.variables ?? JSON.parse(url.searchParams.get('variables') ?? '{}');
      const features = payload?.features ?? (url.searchParams.has('features') ? JSON.parse(url.searchParams.get('features')!) : undefined);
      configs.set(operation, { url: url.origin + url.pathname, variables, features });
    } catch { /* Invalid native payload is not a usable template. */ }
  }
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const before = session();
    let body: unknown = init?.body;
    if (body === undefined && input instanceof Request && input.method === 'POST' && ['bookmarkTweetToFolder', 'CreateBookmark'].includes(operationOf(raw) ?? '')) {
      try { body = await input.clone().text(); } catch { /* Native fetch still proceeds. */ }
    }
    const ticket = bookmarkTicket(raw, body);
    let response: Response;
    try {
      response = await request(input, init);
      if (ticket) {
        if (!response.ok) ticket.fail(new Error('Xの通常ブックマーク保存が失敗しました。再試行してください。'));
        else void response.clone().json().then(value => {
          if (value.errors?.length || value.data?.tweet_bookmark_put !== 'Done') ticket.fail(new Error('Xの通常ブックマーク保存を確認できません。再試行してください。'));
          else ticket.finish();
        }).catch(() => ticket.fail(new Error('Xの通常ブックマーク保存を確認できません。')));
      }
    } catch (error) { ticket?.fail(new Error('Xの通常ブックマーク通信が失敗しました。')); throw error; }
    if (response.ok && before === session()) capture(raw, new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)), body);
    return response;
  };
  const nativeOpen = XMLHttpRequest.prototype.open, nativeHeader = XMLHttpRequest.prototype.setRequestHeader, nativeSend = XMLHttpRequest.prototype.send;
  const pending = new WeakMap<XMLHttpRequest, { url: string; headers: Headers; account: string }>();
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: any[]) {
    pending.delete(this);
    if (operationOf(String(url))) pending.set(this, { url: String(url), headers: new Headers(), account: session() });
    return (nativeOpen as any).call(this, method, url, ...args);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name: string, value: string) { pending.get(this)?.headers.set(name, value); return nativeHeader.call(this, name, value); };
  XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    const item = pending.get(this);
    const ticket = item && bookmarkTicket(item.url, body);
    if (ticket) {
      this.addEventListener('load', () => {
        try {
          const value = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          if (this.status >= 200 && this.status < 300 && !value.errors?.length && value.data?.tweet_bookmark_put === 'Done') ticket.finish();
          else ticket.fail(new Error('Xの通常ブックマーク保存が失敗しました。'));
        } catch { ticket.fail(new Error('Xの通常ブックマーク保存を確認できません。')); }
      }, { once: true });
      for (const event of ['error', 'abort', 'timeout']) this.addEventListener(event, () => ticket.fail(new Error('Xの通常ブックマーク通信が失敗しました。')), { once: true });
    }
    if (item) this.addEventListener('load', () => { if (this.status >= 200 && this.status < 300 && item.account === session()) capture(item.url, item.headers, body); }, { once: true });
    return nativeSend.call(this, body);
  };
  function errorDetail(errors: unknown): string {
    if (!Array.isArray(errors)) return '';
    return errors.slice(0, 3).map(error => {
      const code = error?.extensions?.code ?? error?.code;
      let message = typeof error?.message === 'string' ? error.message : '';
      // Only server error messages are shown, never response bodies or credentials.
      for (const secret of [headers?.get('authorization'), headers?.get('authorization')?.replace(/^Bearer /, ''), cookie('ct0'), cookie('auth_token'), cookie('twid')]) {
        if (secret) message = message.split(secret).join('[非表示]');
      }
      message = message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [非表示]').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240);
      const safeCode = typeof code === 'number' && Number.isFinite(code) || typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? String(code) : '';
      return [safeCode ? `code ${safeCode}` : '', message].filter(Boolean).join(': ');
    }).filter(Boolean).join(' / ');
  }
  async function json(url: string, init: RequestInit, stage: string, usable: (body: any) => boolean): Promise<any> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const requestHeaders = new Headers(init.headers); requestHeaders.set('content-type', 'application/json');
      const response = await request(url, { ...init, headers: requestHeaders, signal: controller.signal });
      let body: any;
      try { body = await response.json(); } catch { /* Non-JSON HTTP failures still identify the stage and status. */ }
      const errors: any[] = Array.isArray(body?.errors) ? body.errors : [];
      const detail = errorDetail(errors);
      const folderAccessDenied = errors.some(error => String(error?.extensions?.code ?? error?.code) === '37' && /not authorized to use bookmark collections/i.test(error?.message ?? ''));
      if (folderAccessDenied) {
        throw new Error(`Xがフォルダ通信を拒否しました（${stage}・code 37）。通常のブックマークは維持されています。契約状態だけでは原因を特定できないため、拡張の認証・通信条件の調査が必要です。`);
      }
      if (!response.ok || errors.length && !usable(body)) {
        throw new Error(`Xの${stage}に失敗しました（HTTP ${response.status}・${operationOf(url)}）${detail ? ': ' + detail : '。'}`);
      }
      if (!body || typeof body !== 'object') throw new Error(`Xの${stage}の応答を読み取れません（HTTP ${response.status}）。`);
      return body;
    } finally { clearTimeout(timer); }
  }
  async function discover(required: string): Promise<void> {
    if (configs.has(required) && headers) return;
    const scriptUrls = Array.from(document.scripts, script => script.src);
    const candidates = [...scriptUrls, ...performance.getEntriesByType('resource').map(item => item.name)];
    // X's inline Webpack runtime has the current numeric chunk/name/hash maps.
    // Parse its literal mappings; never execute downloaded code or guess hashes.
    const main = scriptUrls.find(raw => /^https:\/\/abs\.twimg\.com\/responsive-web\/[A-Za-z0-9_/-]+\/main\.[A-Za-z0-9]+\.js$/.test(raw));
    if (main) {
      const base = main.slice(0, main.lastIndexOf('/') + 1);
      for (const script of Array.from(document.scripts)) {
        if (script.src) continue;
        const runtime = /\.u=([\s\S]*?)(?=,[A-Za-z_$][\w$]*\.[A-Za-z_$])/.exec(script.textContent ?? '')?.[1];
        if (!runtime) continue;
        const suffix = /\}\)\[[A-Za-z_$][\w$]*\]\+"([a-z]?\.js)"/.exec(runtime)?.[1];
        if (!suffix) continue;
        for (const match of runtime.matchAll(/(\d+):"([A-Za-z0-9_.~-]*Bookmark[A-Za-z0-9_.~-]*)"/g)) {
          const hash = new RegExp('(?:[,{])' + match[1] + ':"([a-f0-9]{8,})"').exec(runtime)?.[1];
          if (hash) candidates.push(base + match[2] + '.' + hash + suffix);
        }
      }
    }
    const assets = [...new Set(candidates)].filter(raw => {
      try { const url = new URL(raw); return url.origin === 'https://abs.twimg.com' && /^\/responsive-web\/[A-Za-z0-9_./~-]+\.js$/.test(url.pathname) && !url.search && /Bookmark/.test(url.pathname); } catch { return false; }
    }).sort((a, b) => Number(!a.includes('shared~bundle.BookmarkFolders~bundle.Bookmarks.')) - Number(!b.includes('shared~bundle.BookmarkFolders~bundle.Bookmarks.'))).slice(0, 12);
    for (const asset of assets) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      let source: string;
      try {
        const response = await request(asset, { credentials: 'omit', redirect: 'error', signal: controller.signal });
        if (!response.ok) continue;
        source = await response.text();
      } finally { clearTimeout(timer); }
      for (const operation of ['BookmarkFoldersSlice', 'bookmarkTweetToFolder']) {
        if (configs.has(operation)) continue;
        const match = new RegExp('queryId:"([A-Za-z0-9_-]+)",operationName:"' + operation + '"').exec(source);
        if (!match) continue;
        const nextOperation = source.indexOf('queryId:', match.index + match[0].length);
        const section = source.slice(match.index, nextOperation < 0 ? match.index + 6000 : nextOperation);
        const switches = /featureSwitches:\[([^\]]*)\]/.exec(section);
        // Only synthesize operations with no unknown required feature flags.
        if (!switches || switches[1].trim()) continue;
        configs.set(operation, { url: location.origin + '/i/api/graphql/' + match[1] + '/' + operation, variables: {} });
      }
      if (configs.has(required) && headers) return;
    }
  }
  let busy = false;
  host.__xOriginalBookmarkFolders = async (operation: string, expectedCsrf: string, folderId?: string, postId?: string, templates?: Record<string, Config>, expectedUserId?: string, nativeHeaders?: Record<string, string>) => {
    if (busy) return { ok: false, error: 'フォルダ操作中です。完了してから再試行してください。' };
    busy = true;
    try {
      reset(); const initial = session();
      if (nativeHeaders && Object.keys(nativeHeaders).length) {
        if (!nativeHeaders.authorization?.startsWith('Bearer ') || nativeHeaders['x-csrf-token'] !== expectedCsrf) throw new Error('X標準通信とフォルダ通信の認証情報が一致しません。');
        headers = new Headers();
        for (const name of ['authorization', 'x-csrf-token', 'x-twitter-auth-type', 'x-twitter-active-user', 'x-twitter-client-language', 'x-act-as-user-id']) {
          if (nativeHeaders[name]) headers.set(name, nativeHeaders[name]);
        }
      }
      const check = () => {
        if (!expectedCsrf || cookie('ct0') !== expectedCsrf || session() !== initial || expectedUserId && userId() !== expectedUserId) throw new Error('Xのアカウントが変わりました。再読み込みしてください。');
        const delegated = headers?.get('x-act-as-user-id');
        if (delegated && delegated !== userId()) throw new Error('Xの操作対象アカウントとログイン中のアカウントが一致しません。代理操作ではフォルダ登録先を確認できません。');
      };
      const checkViewer = (body: any) => {
        const viewer = body?.data?.viewer?.user_results?.result?.rest_id;
        if (viewer !== undefined && (typeof viewer !== 'string' || viewer !== userId())) throw new Error('Xが別アカウントのフォルダ一覧を返しました。登録を停止しました。');
      };
      check();
      // Only public operation metadata is cached. Observed authentication is
      // supplied separately after the background verifies this login's scope.
      for (const name of ['BookmarkFoldersSlice', 'bookmarkTweetToFolder']) {
        const seed = templates?.[name];
        if (configs.has(name) || !seed || operationOf(seed.url) !== name) continue;
        const features = seed.features;
        if (features && (typeof features !== 'object' || Object.values(features).some(value => typeof value !== 'boolean'))) continue;
        configs.set(name, { url: new URL(seed.url, location.href).origin + new URL(seed.url, location.href).pathname, variables: typeof seed.variables?.count === 'number' ? { count: seed.variables.count } : {}, features });
      }
      if (operation !== 'list' && operation !== 'add') throw new Error('フォルダ操作が不正です。');
      await discover(operation === 'list' ? 'BookmarkFoldersSlice' : 'bookmarkTweetToFolder'); check();
      if (!headers) throw new Error('Xの認証情報を自動取得できませんでした。ログイン状態を確認して再取得してください。');
      const config = configs.get(operation === 'list' ? 'BookmarkFoldersSlice' : 'bookmarkTweetToFolder');
      if (!config) throw new Error('Xのフォルダ操作情報を自動取得できませんでした。Xのページを再読み込みして再試行してください。');
      if (operation === 'list') {
        const folders: { id: string; name: string }[] = [], seen = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          check();
          const url = new URL(config.url), variables = { ...config.variables };
          delete variables.cursor;
          delete variables.tweet_id;
          if (cursor) variables.cursor = cursor;
          url.searchParams.set('variables', JSON.stringify(variables));
          if (config.features) url.searchParams.set('features', JSON.stringify(config.features));
          const body = await json(url.href, { credentials: 'include', headers }, 'フォルダ一覧取得', value => Array.isArray(value?.data?.viewer?.user_results?.result?.bookmark_collections_slice?.items)); check();
          checkViewer(body);
          const slice = body.data?.viewer?.user_results?.result?.bookmark_collections_slice;
          if (!Array.isArray(slice?.items)) throw new Error('フォルダ一覧を確認できません。Xのブックマーク画面で利用状態を確認してください。');
          for (const item of slice.items) {
            if (typeof item.id !== 'string' || !/^\d+$/.test(item.id) || typeof item.name !== 'string') throw new Error('Xのフォルダ情報の形式が変わりました。');
            if (!folders.some(folder => folder.id === item.id)) folders.push({ id: item.id, name: item.name });
          }
          cursor = slice.slice_info?.next_cursor ?? slice.next_cursor;
          if (!cursor || cursor === '0') return { ok: true, folders, templates: publicTemplates() };
          if (typeof cursor !== 'string' || seen.has(cursor)) break;
          seen.add(cursor);
        }
        throw new Error('フォルダ一覧を最後まで取得できません。');
      }
      if (operation !== 'add' || !/^\d+$/.test(folderId ?? '') || !/^\d+$/.test(postId ?? '')) throw new Error('保存対象が不正です。');
      const native = nativeBookmarks.get(postId!);
      if (native && native.account === initial && Date.now() - native.at < 30000) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([native.finished, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Xの通常ブックマーク保存が時間切れになりました。')), 15000); })]);
        } finally { clearTimeout(timer); }
        check();
      }
      await discover('BookmarkFoldersSlice'); check();
      const listConfig = configs.get('BookmarkFoldersSlice');
      if (!listConfig) throw new Error('フォルダ登録を確認するための情報を取得できません。');
      check();
      const mutationHeaders = new Headers(headers); mutationHeaders.set('content-type', 'application/json');
      const body = await json(config.url, { method: 'POST', credentials: 'include', headers: mutationHeaders, body: JSON.stringify({ variables: { bookmark_collection_id: folderId, tweet_id: postId }, ...(config.features ? { features: config.features } : {}), queryId: new URL(config.url).pathname.split('/')[4] }) }, 'フォルダ登録', value => value?.data?.bookmark_collection_tweet_put === 'Done');
      check();
      if (body.data?.bookmark_collection_tweet_put !== 'Done') throw new Error('指定フォルダへの登録を確認できません。Xで状態を確認して再試行してください。');
      // X's native folder picker requests tweet_id and reads contains_requested_tweet.
      // Read that membership back instead of treating an optimistic bookmark UI as success.
      for (let attempt = 0; attempt < 3; attempt++) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < 100; page++) {
          check();
          const url = new URL(listConfig.url);
          url.searchParams.set('variables', JSON.stringify({ tweet_id: postId, ...(cursor ? { cursor } : {}) }));
          if (listConfig.features) url.searchParams.set('features', JSON.stringify(listConfig.features));
          const verified = await json(url.href, { credentials: 'include', headers, cache: 'no-store' }, 'フォルダ登録確認', value => Array.isArray(value?.data?.viewer?.user_results?.result?.bookmark_collections_slice?.items)); check();
          checkViewer(verified);
          const slice = verified.data?.viewer?.user_results?.result?.bookmark_collections_slice;
          const folder = Array.isArray(slice?.items) ? slice.items.find((item: { id?: unknown; contains_requested_tweet?: unknown }) => item.id === folderId) : undefined;
          if (folder?.contains_requested_tweet === true) return { ok: true, verified: true };
          if (folder) break;
          cursor = slice?.slice_info?.next_cursor ?? slice?.next_cursor;
          if (!cursor || cursor === '0') break;
          if (typeof cursor !== 'string' || seen.has(cursor) || page === 99) throw new Error('フォルダ所属の確認を最後まで取得できません。');
          seen.add(cursor);
        }
        if (attempt < 2) await new Promise<void>(resolve => setTimeout(resolve, 300));
      }
      throw new Error('Xから追加完了の応答がありましたが、指定フォルダ内に投稿を確認できません。再試行してください。');
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { busy = false; }
  };
  host.__xOriginalBookmarkFolders.version = 6;
})();
