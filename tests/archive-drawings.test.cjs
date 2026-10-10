const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// HTML内の実際のイベント処理を実行する。SDK・通信・DOMだけを置き換え、外部には接続しない。
const html = fs.readFileSync(path.join(__dirname, '..', 'controller', 'index.html'), 'utf8');
const inlineScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .find((script) => script.includes('function uploadDrawing'))
  .replace("const SUPABASE_URL = 'SUPABASE_URL';", "const SUPABASE_URL = 'https://test.invalid';")
  .replace("const SUPABASE_KEY = 'SUPABASE_KEY';", "const SUPABASE_KEY = 'test-key';");

const SOURCE_BUCKET = 'chair-person-backrest';
const ARCHIVE_BUCKET = 'chair-person-archive';
const imageControlIds = ['change', 'fetch', 'open-drawing', 'archive-drawings'];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function file(name, id = name) {
  return { name, id };
}

function createController(options = {}) {
  const state = {
    files: [...(options.files || [])],
    archived: new Set(options.archived || []),
    lists: [],
    moves: [],
    uploads: [],
    messages: [],
    operations: [],
    logs: [],
  };
  const elements = new Map();
  const noop = () => {};
  const drawingContext = new Proxy({}, { get: (target, key) => target[key] || noop });

  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const handlers = new Map();
    const classes = new Set();
    const result = {
      id,
      value: '10',
      hidden: id === 'drawing-mode' || id === 'swipe-overlay',
      disabled: false,
      textContent: '',
      dataset: {},
      style: { setProperty: noop, removeProperty: noop },
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
      },
      width: 1536,
      height: 2048,
      clientWidth: 768,
      clientHeight: 1024,
      addEventListener(name, callback) { handlers.set(name, callback); },
      setAttribute: noop,
      getContext: () => drawingContext,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 768, height: 1024 }),
      setPointerCapture: noop,
      hasPointerCapture: () => false,
      releasePointerCapture: noop,
      toBlob: (callback) => options.onBlob
        ? options.onBlob(callback)
        : callback({ type: 'image/png' }),
      handlers,
    };
    elements.set(id, result);
    return result;
  }

  // 実在しないボタンのテストを通さないよう、HTMLにあるIDだけをクリック対象にする。
  const renderedIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  function $(selector) {
    if (typeof selector === 'function') {
      selector();
      return;
    }
    const selected = selector.split(',').map((part) => element(part.trim().replace(/^#/, '')));
    return {
      on(event, callback) {
        selected.forEach((item) => item.addEventListener(event, callback));
        return this;
      },
      prop(property, value) {
        selected.forEach((item) => { item[property] = value; });
        return this;
      },
      text(value) {
        selected.forEach((item) => { item.textContent = value; });
        return this;
      },
    };
  }

  $.get = (url, { data }) => {
    state.messages.push(data);
    state.operations.push({ type: 'message', data });
    let onSuccess;
    let onFailure;
    Promise.resolve().then(async () => {
      try {
        await options.onMessage?.(data, state);
        onSuccess?.();
      } catch (error) {
        onFailure?.(error);
      }
    });
    const request = {
      done(callback) { onSuccess = callback; return request; },
      fail(callback) { onFailure = callback; return request; },
    };
    return request;
  };

  const supabase = {
    createClient() {
      return {
        storage: {
          from(bucket) {
            return {
              async list(prefix, query) {
                const call = { bucket, prefix, query };
                state.lists.push(call);
                state.operations.push({ type: 'list', ...call });
                const overridden = await options.onList?.(call, state);
                if (overridden) return overridden;
                const sorted = [...state.files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
                return { data: sorted.slice(query.offset, query.offset + query.limit), error: null };
              },
              async move(from, to, moveOptions) {
                const call = { bucket, from, to, options: moveOptions };
                state.moves.push(call);
                state.operations.push({ type: 'move', ...call });
                const overridden = await options.onMove?.(call, state);
                if (overridden) return overridden;
                if (state.archived.has(to)) {
                  return { data: null, error: { message: 'The resource already exists', code: 'ResourceAlreadyExists', status: 409 } };
                }
                state.files = state.files.filter((item) => item.name !== from);
                state.archived.add(to);
                return { data: {}, error: null };
              },
              async upload(name, blob, uploadOptions) {
                const call = { bucket, name, blob, options: uploadOptions };
                state.uploads.push(call);
                const overridden = await options.onUpload?.(call, state);
                if (overridden) return overridden;
                return { data: {}, error: null };
              },
            };
          },
        },
      };
    },
  };

  const timers = new Map();
  let nextTimerId = 0;
  let elapsedTime = 0;
  function advanceTimersBy(duration) {
    const targetTime = elapsedTime + duration;
    while (true) {
      const next = [...timers.values()]
        .filter((timer) => timer.at <= targetTime)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      elapsedTime = next.at;
      timers.delete(next.id);
      next.callback();
    }
    elapsedTime = targetTime;
  }
  const window = {
    supabase,
    addEventListener: noop,
    requestAnimationFrame: noop,
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { id, callback, delay, at: elapsedTime + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(inlineScript, {
    $,
    window,
    document: {
      body: { style: {} },
      getElementById: element,
      querySelector: (selector) => element(selector),
    },
    console: { log: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args) },
  }, { filename: 'controller/index.html' });

  return {
    state,
    element,
    async click(id) {
      assert.ok(renderedIds.has(id), `HTML must contain #${id}`);
      const handler = element(id).handlers.get('click');
      assert.equal(typeof handler, 'function', `#${id} must have a click handler`);
      // disabledを意図的に無視して呼び、イベントが重なっても処理自身が拒否できるか調べる。
      await handler();
    },
    event(id, type, values = {}) {
      return element(id).handlers.get(type)?.({ preventDefault: noop, stopPropagation: noop, ...values });
    },
    status() {
      const result = element('controller-status');
      return { text: result.textContent, state: result.dataset.state };
    },
    runTimers: advanceTimersBy,
    advanceTimersBy,
    activeTimerCount: (delay) => [...timers.values()].filter((timer) => timer.delay === delay).length,
    assertControlsDisabled(disabled) {
      for (const id of imageControlIds) assert.equal(element(id).disabled, disabled, `#${id}.disabled`);
    },
  };
}

test('全ページを取得後にdrawing-のファイルだけを移動し、最後に1回だけ通知する', async () => {
  const drawings = Array.from({ length: 205 }, (_, index) => file(`drawing-${String(index).padStart(3, '0')}.png`));
  const untouched = [file('tie_black.jpg'), file('not-drawing.png'), file('drawing-folder', null), file('drawing.png')];
  const controller = createController({ files: [...drawings, ...untouched] });

  await controller.click('archive-drawings');

  assert.deepEqual(controller.state.lists.map((call) => call.query.offset), [0, 100, 200]);
  for (const call of controller.state.lists) {
    assert.equal(call.bucket, SOURCE_BUCKET);
    assert.equal(call.prefix, '');
    assert.equal(call.query.limit, 100);
    assert.equal(call.query.sortBy.column, 'name');
    assert.equal(call.query.sortBy.order, 'asc');
  }
  assert.deepEqual(controller.state.operations.slice(0, 3).map((operation) => operation.type), ['list', 'list', 'list']);
  assert.deepEqual(controller.state.moves.map((call) => call.from), drawings.map((item) => item.name));
  for (const call of controller.state.moves) {
    assert.equal(call.bucket, SOURCE_BUCKET);
    assert.equal(call.to, call.from);
    assert.equal(call.options.destinationBucket, ARCHIVE_BUCKET);
    assert.notEqual(call.options.upsert, true);
  }
  assert.deepEqual(controller.state.files.map((item) => item.name).sort(), untouched.map((item) => item.name).sort());
  assert.deepEqual(controller.state.messages, ['image-fetch']);
  assert.equal(controller.state.operations.at(-1).type, 'message');
  assert.equal(controller.status().state, 'success');
  assert.match(controller.status().text, /205/);
  assert.match(controller.status().text, /画像/);
  controller.assertControlsDisabled(false);
});

test('移動対象が0件でも再試行用にimage-fetchを1回送る', async () => {
  const controller = createController({ files: [file('tie_black.jpg')] });
  await controller.click('archive-drawings');
  assert.equal(controller.state.moves.length, 0);
  assert.deepEqual(controller.state.messages, ['image-fetch']);
  assert.equal(controller.status().state, 'success');
  controller.assertControlsDisabled(false);
});

test('2ページ目の一覧取得に失敗したら移動せず通知せずロックを解除する', async () => {
  const drawings = Array.from({ length: 101 }, (_, index) => file(`drawing-${index}.png`));
  const controller = createController({
    files: drawings,
    onList: ({ query }) => query.offset === 100
      ? { data: null, error: { message: 'Load failed', code: 'NetworkError' } }
      : undefined,
  });
  await controller.click('archive-drawings');
  assert.equal(controller.state.moves.length, 0);
  assert.deepEqual(controller.state.files, drawings);
  assert.deepEqual(controller.state.messages, []);
  assert.equal(controller.status().state, 'error');
  assert.match(controller.status().text, /Load failed/);
  controller.assertControlsDisabled(false);
});

test('途中の移動失敗では残りを止め、移動済みの一覧を通知して失敗ファイルを表示する', async () => {
  const controller = createController({
    files: [file('drawing-a.png'), file('drawing-b.png'), file('drawing-c.png')],
    onMove: ({ from }) => from === 'drawing-b.png'
      ? { error: { message: 'Permission denied', status: 403, code: 'AccessDenied' } }
      : undefined,
  });
  await controller.click('archive-drawings');
  assert.deepEqual(controller.state.moves.map((call) => call.from), ['drawing-a.png', 'drawing-b.png']);
  assert.deepEqual([...controller.state.archived], ['drawing-a.png']);
  assert.deepEqual(controller.state.files.map((item) => item.name), ['drawing-b.png', 'drawing-c.png']);
  assert.deepEqual(controller.state.messages, ['image-fetch']);
  assert.equal(controller.status().state, 'error');
  assert.match(controller.status().text, /drawing-b\.png/);
  assert.match(controller.status().text, /Permission denied/);
  assert.match(controller.status().text, /403/);
  assert.match(controller.status().text, /AccessDenied/);
  assert.match(controller.status().text, /1/);
  assert.match(controller.status().text, /3/);
  controller.assertControlsDisabled(false);
});

test('通知だけ失敗しても移動済み画像を戻さず、再実行で通知を再試行できる', async () => {
  let failNotification = true;
  const controller = createController({
    files: [file('drawing-a.png')],
    onMessage: () => { if (failNotification) throw new Error('Load failed'); },
  });
  await controller.click('archive-drawings');
  assert.deepEqual([...controller.state.archived], ['drawing-a.png']);
  assert.equal(controller.state.files.length, 0);
  assert.equal(controller.status().state, 'error');
  assert.match(controller.status().text, /画像/);
  assert.match(controller.status().text, /1枚/);
  assert.match(controller.status().text, /更新要求に失敗/);
  assert.match(controller.status().text, /画像を更新/);
  controller.assertControlsDisabled(false);

  failNotification = false;
  await controller.click('archive-drawings');
  assert.equal(controller.state.moves.length, 1);
  assert.deepEqual(controller.state.messages, ['image-fetch', 'image-fetch']);
  assert.equal(controller.status().state, 'success');
});

test('移動先に同名の画像がある場合は上書きや削除を行わずエラーを示す', async () => {
  const controller = createController({
    files: [file('drawing-a.png'), file('drawing-b.png')],
    archived: ['drawing-a.png'],
  });
  await controller.click('archive-drawings');
  assert.equal(controller.state.moves.length, 1);
  assert.deepEqual(controller.state.files.map((item) => item.name), ['drawing-a.png', 'drawing-b.png']);
  assert.deepEqual([...controller.state.archived], ['drawing-a.png']);
  assert.deepEqual(controller.state.messages, ['image-fetch']);
  assert.equal(controller.status().state, 'error');
  assert.match(controller.status().text, /ResourceAlreadyExists/);
  controller.assertControlsDisabled(false);
});

test('保管中の連打・画像変更・一覧更新・お絵描き開始・アップロードを拒否する', async () => {
  const listGate = deferred();
  const controller = createController({
    files: [file('drawing-a.png')],
    onList: () => listGate.promise,
  });
  const archiving = controller.click('archive-drawings');
  controller.assertControlsDisabled(true);

  await Promise.all([
    controller.click('archive-drawings'),
    controller.click('change'),
    controller.click('fetch'),
    controller.click('open-drawing'),
    controller.click('start-transfer'),
  ]);
  controller.event('swipe-preview', 'pointerdown', { pointerId: 1, clientY: 700, pointerType: 'touch' });
  controller.event('swipe-preview', 'pointerup', { pointerId: 1, clientY: 100, pointerType: 'touch' });
  await Promise.resolve();

  assert.equal(controller.state.lists.length, 1);
  assert.equal(controller.element('drawing-mode').hidden, true);
  assert.equal(controller.state.uploads.length, 0);
  assert.deepEqual(controller.state.messages, []);

  listGate.resolve();
  await archiving;
  assert.equal(controller.state.moves.length, 1);
  assert.deepEqual(controller.state.messages, ['image-fetch']);
  controller.assertControlsDisabled(false);
});

test('手動のimage-fetch送信中は保管を開始せず、通知完了後に操作を戻す', async () => {
  const messageGate = deferred();
  const controller = createController({
    files: [file('drawing-a.png')],
    onMessage: () => messageGate.promise,
  });
  const fetching = controller.click('fetch');
  controller.assertControlsDisabled(true);
  await controller.click('archive-drawings');
  await controller.click('change');
  assert.equal(controller.state.lists.length, 0);
  assert.deepEqual(controller.state.messages, ['image-fetch']);
  messageGate.resolve();
  await fetching;
  controller.assertControlsDisabled(false);
});

test('描いた絵の転送中は保管と画像操作を拒否し、転送結果を閉じてから解除する', async () => {
  const uploadGate = deferred();
  const uploadStarted = deferred();
  const notificationSent = deferred();
  const controller = createController({
    files: [file('drawing-a.png')],
    onUpload: () => { uploadStarted.resolve(); return uploadGate.promise; },
    onMessage: () => notificationSent.resolve(),
  });
  await controller.click('open-drawing');
  await controller.click('start-transfer');
  controller.event('swipe-preview', 'pointerdown', { pointerId: 1, clientY: 700, pointerType: 'touch' });
  controller.event('swipe-preview', 'pointerup', { pointerId: 1, clientY: 100, pointerType: 'touch' });
  await uploadStarted.promise;
  controller.assertControlsDisabled(true);
  await controller.click('archive-drawings');
  await controller.click('fetch');
  await controller.click('change');
  assert.equal(controller.state.lists.length, 0);
  assert.deepEqual(controller.state.messages, []);

  uploadGate.resolve();
  await notificationSent.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.state.messages, ['image-fetch']);
  controller.assertControlsDisabled(true);
  controller.runTimers(1600);
  controller.assertControlsDisabled(false);
});

// Promiseの完了処理を実行してから画面状態を確認する。実際の通信や25秒の待機は行わない。
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

async function startDrawingTransfer(controller) {
  await controller.click('open-drawing');
  await controller.click('start-transfer');
  controller.event('swipe-preview', 'pointerdown', { pointerId: 1, clientY: 700, pointerType: 'touch' });
  controller.event('swipe-preview', 'pointerup', { pointerId: 1, clientY: 100, pointerType: 'touch' });
  await flushAsync();
}

test('PNG化が応答しない場合も25秒で解除し、遅いPNG結果からアップロードしない', async () => {
  let finishBlob;
  const controller = createController({ onBlob: (callback) => { finishBlob = callback; } });
  await startDrawingTransfer(controller);

  controller.advanceTimersBy(24999);
  await flushAsync();
  controller.assertControlsDisabled(true);
  assert.match(controller.element('swipe-overlay').className, /is-uploading/);

  controller.advanceTimersBy(1);
  await flushAsync();
  controller.assertControlsDisabled(false);
  assert.equal(controller.element('cancel-transfer').disabled, false);
  assert.equal(controller.element('drawing-mode').hidden, false);
  assert.equal(controller.element('swipe-title').textContent, '転送の確認がタイムアウトしました');
  assert.doesNotMatch(controller.element('swipe-overlay').className, /is-uploading/);

  finishBlob({ type: 'image/png' });
  await flushAsync();
  assert.equal(controller.state.uploads.length, 0);
  assert.deepEqual(controller.state.messages, []);
});

for (const lateResult of ['success', 'failure']) {
  test(`アップロード時間切れ後に再試行でき、前回の遅い${lateResult}は新しい結果を変更しない`, async () => {
    const uploadGate = deferred();
    const controller = createController({
      onUpload: (call, state) => state.uploads.length === 1 ? uploadGate.promise : undefined,
    });
    await startDrawingTransfer(controller);
    assert.equal(controller.state.uploads.length, 1);

    controller.advanceTimersBy(25000);
    await flushAsync();
    controller.assertControlsDisabled(false);
    assert.equal(controller.element('cancel-transfer').disabled, false);
    assert.equal(controller.element('drawing-mode').hidden, false);
    assert.equal(controller.element('swipe-title').textContent, '転送の確認がタイムアウトしました');
    assert.match(controller.element('swipe-message').textContent, /保存されている場合/);
    assert.doesNotMatch(controller.element('swipe-overlay').className, /is-uploading/);
    assert.deepEqual(controller.state.messages, []);

    await startDrawingTransfer(controller);
    assert.equal(controller.state.uploads.length, 2);
    assert.deepEqual(controller.state.messages, ['image-fetch']);
    assert.equal(controller.element('swipe-title').textContent, '転送できました');
    assert.equal(controller.activeTimerCount(25000), 0);

    if (lateResult === 'success') uploadGate.resolve({ data: {}, error: null });
    else uploadGate.reject(new Error('Load failed'));
    await flushAsync();
    assert.deepEqual(controller.state.messages, ['image-fetch']);
    assert.equal(controller.element('swipe-title').textContent, '転送できました');
    controller.assertControlsDisabled(true);
    controller.advanceTimersBy(1600);
    controller.assertControlsDisabled(false);
  });
}

test('初回成功のタイマーを解除し、2回目のアップロードも開始から25秒で打ち切る', async () => {
  const uploadGate = deferred();
  const controller = createController({
    onUpload: (call, state) => state.uploads.length === 2 ? uploadGate.promise : undefined,
  });
  await startDrawingTransfer(controller);
  assert.equal(controller.element('swipe-title').textContent, '転送できました');
  assert.equal(controller.activeTimerCount(25000), 0);
  controller.advanceTimersBy(1600);
  controller.assertControlsDisabled(false);

  await startDrawingTransfer(controller);
  assert.equal(controller.activeTimerCount(25000), 1);
  // 初回開始から25秒の時点では、2回目の期限にはまだ到達していない。
  controller.advanceTimersBy(23400);
  await flushAsync();
  controller.assertControlsDisabled(true);
  controller.advanceTimersBy(1599);
  await flushAsync();
  assert.match(controller.element('swipe-overlay').className, /is-uploading/);
  controller.advanceTimersBy(1);
  await flushAsync();
  controller.assertControlsDisabled(false);
  assert.equal(controller.element('swipe-title').textContent, '転送の確認がタイムアウトしました');
  assert.deepEqual(controller.state.messages, ['image-fetch']);

  uploadGate.resolve();
  await flushAsync();
  assert.deepEqual(controller.state.messages, ['image-fetch']);
});

test('保存後の通知には別途15秒を確保し、時間切れでは保存済みであることを示す', async () => {
  const uploadGate = deferred();
  const messageGate = deferred();
  const controller = createController({
    onUpload: () => uploadGate.promise,
    onMessage: () => messageGate.promise,
  });
  await startDrawingTransfer(controller);
  controller.advanceTimersBy(20000);
  uploadGate.resolve();
  await flushAsync();
  assert.deepEqual(controller.state.messages, ['image-fetch']);
  assert.equal(controller.activeTimerCount(25000), 0);
  assert.equal(controller.activeTimerCount(15000), 1);

  controller.advanceTimersBy(14999);
  await flushAsync();
  assert.match(controller.element('swipe-overlay').className, /is-uploading/);
  controller.advanceTimersBy(1);
  await flushAsync();
  assert.doesNotMatch(controller.element('swipe-overlay').className, /is-uploading/);
  assert.equal(controller.element('swipe-title').textContent, '画像を転送しました');
  assert.match(controller.element('swipe-message').textContent, /時間内に完了しませんでした/);
  assert.match(controller.element('swipe-message').textContent, /画像を更新/);
  assert.equal(controller.state.uploads.length, 1);
  assert.equal(controller.activeTimerCount(15000), 0);

  messageGate.resolve();
  await flushAsync();
  assert.equal(controller.element('swipe-title').textContent, '画像を転送しました');
  controller.advanceTimersBy(1600);
  controller.assertControlsDisabled(false);
  assert.equal(controller.element('cancel-transfer').disabled, false);
  assert.equal(controller.element('drawing-status').dataset.state, 'error');
  assert.match(controller.element('drawing-status').textContent, /画像を更新/);
});

test('通知成功時に15秒のタイマーを解除し、2回目の通知を早く打ち切らない', async () => {
  const messageGate = deferred();
  const controller = createController({
    onMessage: (message, state) => state.messages.length === 2 ? messageGate.promise : undefined,
  });
  await startDrawingTransfer(controller);
  assert.equal(controller.element('swipe-title').textContent, '転送できました');
  assert.equal(controller.activeTimerCount(15000), 0);
  controller.advanceTimersBy(1600);

  await startDrawingTransfer(controller);
  assert.equal(controller.activeTimerCount(15000), 1);
  // 初回通知から15秒の時点を過ぎても、2回目の通知にはまだ待ち時間が残る。
  controller.advanceTimersBy(14999);
  await flushAsync();
  assert.match(controller.element('swipe-overlay').className, /is-uploading/);
  controller.advanceTimersBy(1);
  await flushAsync();
  assert.equal(controller.element('swipe-title').textContent, '画像を転送しました');
  assert.equal(controller.activeTimerCount(15000), 0);
  assert.deepEqual(controller.state.messages, ['image-fetch', 'image-fetch']);

  messageGate.resolve();
  await flushAsync();
  controller.advanceTimersBy(1600);
  controller.assertControlsDisabled(false);
});
