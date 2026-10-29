// Run with: node --test tests/extraction.test.cjs
// Uses synthetic schedules and mocked Gemini responses; sends no network requests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

class Element {
  constructor(classes = '') {
    this.className = classes;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      },
    };
  }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html || ''; }
  appendChild(child) { this.children.push(child); }
  addEventListener() {}
  scrollIntoView() {}
}

function setup(options = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[0].match(/\bclass="([^"]*)"/)?.[1]);
    element.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    elements.set(match[1], element);
  }
  const timers = new Map();
  const storage = new Map(Object.entries(options.storage || {}));
  const readers = [];
  const images = [];
  let timerId = 0;
  const context = vm.createContext({
    document: {
      getElementById: id => { assert.ok(elements.has(id), `Unknown element: ${id}`); return elements.get(id); },
      createElement: () => new Element(),
      querySelectorAll: selector => selector === '.step-section'
        ? ['s1', 's2', 's3'].map(id => elements.get(id)) : [],
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    window: { scrollTo() {} },
    setTimeout: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
    AbortController,
    atob,
    File,
    Uint8Array,
    navigator: {},
    console,
    FileReader: class { constructor() { readers.push(this); } readAsDataURL() {} },
    Image: class { constructor() { images.push(this); } },
    fetch: () => { throw new Error('Unexpected network request'); },
    ...options.globals,
  });
  vm.runInContext(script, context);
  vm.runInContext("S.year = 2026; S.month = 10; S.empName = 'Test'; S.imageBase64 = 'TEST_IMAGE'; S.imageMime = 'image/png';", context);
  elements.get('geminiKey').value = 'test-only-key';
  return { context, elements, timers, storage, readers, images, run: code => vm.runInContext(code, context) };
}

const schedule = { found: true, employee: 'Test', daysDetected: 31,
  schedule: Array.from({ length: 31 }, (_, i) => ({ date: i + 1, code: i % 7 === 0 ? 'RO' : 'M' })) };
const response = parts => ({ candidates: [{ finishReason: 'STOP', content: { parts } }] });
const successResponse = () => response([{ text: JSON.stringify(schedule) }]);
const ok = data => ({ ok: true, json: async () => data });

test('parses JSON following a signature-only or thought part, including split text', () => {
  const app = setup();
  const json = JSON.stringify(schedule);
  const data = response([{ thought: true, text: 'reasoning' }, { thoughtSignature: 'signature' },
    { text: json.slice(0, 80) }, { text: json.slice(80) }]);
  // The old first-part parser cannot parse this valid multi-part response.
  assert.throws(() => JSON.parse(data.candidates[0].content.parts[0].text));
  assert.equal(app.context.parseExtractionResponse(data).schedule.length, 31);
  assert.equal(app.context.parseExtractionResponse(response([{ text: '```json\n' + json + '\n```' }])).found, true);
});

test('rejects empty, truncated, blocked, malformed, and invalid schedule responses', () => {
  const { context } = setup();
  const cases = [
    [{}, /未回傳/],
    [{ promptFeedback: { blockReason: 'SAFETY' } }, /SAFETY/],
    [{ candidates: [{ finishReason: 'MAX_TOKENS' }] }, /長度限制/],
    [{ candidates: [{ finishReason: 'SAFETY' }] }, /未完成/],
    [response([{ text: '{' }]), /無法解析/],
    [response([{ text: 'null' }]), /不完整/],
    [response([{ text: '{"found":"false"}' }]), /不完整/],
    [response([{ text: '{"found":true,"schedule":[]}' }]), /不完整/],
    [response([{ text: '{"found":true,"schedule":[null]}' }]), /不完整/],
    [response([{ text: '{"found":true,"schedule":[{"date":1.5,"code":"M"}]}' }]), /不完整/],
    [response([{ text: '{"found":false,"availableNames":"Test"}' }]), /不完整/],
  ];
  for (const [data, error] of cases) assert.throws(() => context.parseExtractionResponse(data), error);
});

test('successful extraction renders the calendar and sends the current key in a header', async () => {
  const app = setup();
  let request;
  app.context.fetch = async (url, options) => { request = { url, options }; return ok(successResponse()); };
  await app.context.runExtraction();
  assert.match(request.url, /gemini-3\.8-flash:generateContent$/);
  assert.equal(JSON.parse(request.options.body).generationConfig.temperature, undefined);
  assert.ok(!request.url.includes('key='));
  assert.equal(request.options.headers['x-goog-api-key'], 'test-only-key');
  assert.equal(JSON.parse(request.options.body).contents[0].parts[0].inlineData.data, 'TEST_IMAGE');
  assert.equal(app.run('S.schedule.length'), 31);
  assert.equal(app.elements.get('resultContent').classList.contains('hidden'), false);
  assert.equal(app.elements.get('confirmExtractionBtn').disabled, false);
  assert.ok(app.elements.get('calendarGrid').children.length >= 38);
  assert.equal(app.timers.size, 0);
});

test('a new failed extraction hides stale results, clears schedules and prevents export', async () => {
  const app = setup();
  app.context.fetch = async () => ok(successResponse());
  await app.context.runExtraction();
  app.context.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });
  await app.context.runExtraction();
  assert.equal(app.run('S.schedule.length'), 0);
  assert.equal(app.elements.get('resultContent').classList.contains('hidden'), true);
  assert.equal(app.elements.get('confirmExtractionBtn').disabled, true);
  assert.equal(app.elements.get('extractionErrorTitle').textContent, '班表辨識失敗');
  assert.match(app.elements.get('notFoundMsg').textContent, /額度/);
  app.context.goToStep(3);
  assert.equal(app.elements.get('s3').classList.contains('active'), false);
  assert.match(app.elements.get('toast').textContent, /成功辨識/);
});

test('not-found is distinct from API failure and offers the returned employee names', async () => {
  const app = setup();
  app.context.fetch = async () => ok(response([{ text: '{"found":false,"availableNames":["Other"]}' }]));
  await app.context.runExtraction();
  assert.equal(app.elements.get('extractionErrorTitle').textContent, '找不到此員工');
  assert.equal(app.elements.get('availableNames').children[0].children[0].textContent, 'Other');
  assert.equal(app.elements.get('confirmExtractionBtn').disabled, true);
});

test('the exact screenshot error is explained as depleted prepaid credits, with an actionable link', async () => {
  const app = setup();
  const message = 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing. Learn more at https://ai.google.dev/gemini-api/docs/billing#prepay.';
  app.context.fetch = async () => ({ ok: false, status: 402, json: async () => ({ error: { message } }) });
  await app.context.runExtraction();
  assert.equal(app.elements.get('extractionErrorTitle').textContent, '班表辨識失敗');
  assert.match(app.elements.get('notFoundMsg').textContent, /預付額度已用完/);
  assert.equal(app.elements.get('billingHelp').classList.contains('hidden'), false);
  assert.equal(app.elements.get('confirmExtractionBtn').disabled, true);
  assert.match(html, /href="https:\/\/ai\.studio\/projects"/);
  // Specific billing messages must not be masked by a generic quota/permission explanation.
  assert.match(app.context.explainApiError(429, message), /預付額度已用完/);
  app.context.fetch = async () => ok(successResponse());
  await app.context.runExtraction();
  assert.equal(app.elements.get('billingHelp').classList.contains('hidden'), true);
  assert.equal(app.elements.get('confirmExtractionBtn').disabled, false);
});

test('timeouts stop loading and concurrent clicks produce only one request', async () => {
  const app = setup();
  let calls = 0;
  app.context.fetch = (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    }));
  };
  const pending = app.context.runExtraction();
  await app.context.runExtraction();
  assert.equal(calls, 1);
  [...app.timers.values()].find(timer => timer.ms === 90000).callback();
  await pending;
  assert.match(app.elements.get('notFoundMsg').textContent, /逾時/);
  assert.equal(app.run('S.extracting'), false);
  assert.equal(app.elements.get('scanLine').style.display, 'none');
  assert.equal(app.elements.get('scanOverlay').classList.contains('show'), false);
  assert.equal(app.elements.get('loadingState').classList.contains('hidden'), true);
  assert.equal(app.timers.size, 0);
});

test('a restored draft can be reviewed, while re-extraction requires the original image', async () => {
  const app = setup();
  app.storage.set('sched_draft', JSON.stringify({ empName: 'Test', year: 2026, month: 10, schedule: schedule.schedule }));
  app.run('S.imageBase64 = null');
  app.context.resumeDraft();
  assert.equal(app.elements.get('confirmExtractionBtn').disabled, false);
  await app.context.reExtract();
  assert.match(app.elements.get('toast').textContent, /重新上傳/);
  assert.equal(app.elements.get('s1').classList.contains('active'), true);
});

test('file read and image decode errors never become successful uploads', () => {
  const app = setup();
  app.context.handleImageFile({ type: 'image/png' });
  assert.equal(app.run('S.imageLoading'), true);
  app.readers[0].onerror();
  assert.equal(app.run('S.imageLoading'), false);
  assert.equal(app.run('S.imageBase64'), null);
  assert.match(app.elements.get('toast').textContent, /無法讀取圖片/);
  app.context.handleImageFile({ type: 'image/heic' });
  app.readers[1].onload({ target: { result: 'data:image/heic;base64,TEST' } });
  app.images[0].onerror();
  assert.equal(app.run('S.imageBase64'), null);
  assert.equal(app.elements.get('uploadPreview').style.display, 'none');
});

test('only the most recently selected image may update the preview', () => {
  const app = setup();
  app.context.handleImageFile({ type: 'image/png' });
  app.context.handleImageFile({ type: 'image/png' });
  app.readers[1].onload({ target: { result: 'data:image/png;base64,NEW' } });
  app.images[0].onload(); // No canvas available in this mock: exercises original PNG fallback.
  app.readers[0].onload({ target: { result: 'data:image/png;base64,OLD' } });
  assert.equal(app.run('S.imageBase64'), 'NEW');
  assert.equal(app.elements.get('previewImg').src, 'data:image/png;base64,NEW');
});

test('settings are remembered, folded away after setup, and only supported models are accepted', () => {
  const app = setup({ storage: { sched_name:'Saved name', sched_gemini_key:'saved-key', sched_gemini_model:'gemini-4-argon' } });
  assert.equal(app.elements.get('personalSettings').open, false);
  assert.match(app.elements.get('profileSummary').textContent, /Saved name/);
  assert.equal(app.context.selectedModel(), 'gemini-4-argon');
  app.elements.get('geminiModel').value = 'untrusted/model';
  assert.equal(app.context.selectedModel(), 'gemini-3.8-flash');
  app.context.clearKey();
  assert.match(app.elements.get('profileSummary').textContent, /先設定/);
});

test('the explicitly selected Argon model uses compatible configuration without automatic fallback', async () => {
  const app = setup();
  app.elements.get('geminiModel').value = 'gemini-4-argon';
  const requests = [];
  app.context.fetch = async (url, opts) => { requests.push({ url, body:JSON.parse(opts.body) }); return ok(successResponse()); };
  await app.context.runExtraction();
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /gemini-4-argon:generateContent$/);
  assert.equal(requests[0].body.generationConfig.maxOutputTokens, 32768);
  assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(requests[0].body.generationConfig.temperature, undefined);
});

test('a detected month is applied before validating and rendering its dates', async () => {
  const app = setup();
  const february = { ...schedule, year:2028, month:2, daysDetected:29, schedule:schedule.schedule.slice(0,29) };
  app.context.fetch = async () => ok(response([{ text:JSON.stringify(february) }]));
  await app.context.runExtraction();
  assert.equal(app.run('S.year'), 2028);
  assert.equal(app.run('S.month'), 2);
  assert.equal(app.run('S.schedule.length'), 29);
  assert.equal(app.elements.get('validateWarn').classList.contains('hidden'), true);
  assert.match(app.elements.get('detectedPeriodNotice').textContent, /2028 年 2 月/);
  assert.equal(app.elements.get('selYear').value, 2028);
  const events = app.context.buildEvents();
  assert.ok(events.length > 0);
  assert.ok(events.every(event => event.startStr.startsWith('202802')));
});

test('uncertain image dates keep the chosen period and ask the user to check it', async () => {
  const app = setup();
  app.context.fetch = async () => ok(successResponse());
  await app.context.runExtraction();
  assert.equal(app.run('S.month'), 10);
  assert.match(app.elements.get('detectedPeriodNotice').textContent, /無法完整確認/);
});

test('sharing accepts only tagged JPEG payloads and rejects arbitrary clipboard content', () => {
  const { context } = setup();
  assert.equal(context.parseSharedImage('ELIS_SCHEDULE_IMAGE_V1:/9j/\nAA=='), '/9j/AA==');
  for (const text of ['secret', 'https://example.com', 'ELIS_SCHEDULE_IMAGE_V1:',
    'ELIS_SCHEDULE_IMAGE_V1:<script>', 'ELIS_SCHEDULE_IMAGE_V1:aGVsbG8=']) {
    assert.throws(() => context.parseSharedImage(text));
  }
});

test('clipboard import waits for a tap and uses the existing image decoding pipeline', async () => {
  let reads = 0;
  const app = setup({ globals:{ navigator:{ clipboard:{ readText:async () => { reads++; return 'ELIS_SCHEDULE_IMAGE_V1:/9j/AA=='; } } } } });
  assert.equal(reads, 0);
  await app.context.importClipboardImage();
  assert.equal(reads, 1);
  assert.equal(app.readers.length, 1);
  assert.equal(app.run('S.imageLoading'), true);
});

test('clipboard denial offers manual paste without starting a network request', async () => {
  const app = setup({ globals:{ navigator:{ clipboard:{ readText:async () => { throw new Error('Denied'); } } } } });
  await app.context.importClipboardImage();
  assert.equal(app.elements.get('pasteFallback').classList.contains('hidden'), false);
  assert.match(app.elements.get('toast').textContent, /允許貼上/);
});

test('only the known shortcut arrival marker is consumed and it never reads clipboard automatically', () => {
  let replaced;
  const app = setup({ globals:{ location:{hash:'#shortcut',pathname:'/',search:''}, history:{replaceState:(a,b,c) => { replaced = c; }} } });
  assert.equal(app.elements.get('shortcutArrival').classList.contains('hidden'), false);
  assert.equal(replaced, '/');
});

test('a failed request preserves the image for the next attempt and a restored image can retry', async () => {
  const app = setup();
  app.run("S.imageDataUrl='data:image/jpeg;base64,/9j/AA=='; S.imageMime='image/jpeg'");
  app.context.fetch = async () => ({ ok:false, status:402, json:async () => ({ error:{message:'Your prepayment credits are depleted.'} }) });
  await app.context.runExtraction();
  assert.equal(app.run('S.imageDataUrl'), 'data:image/jpeg;base64,/9j/AA==');
  const draft = JSON.parse(app.storage.get('sched_draft'));
  assert.equal(draft.schedule.length, 0);
  assert.equal(draft.empName, 'Test');
  app.run("S.draftImage={imageDataUrl:'data:image/jpeg;base64,/9j/AA==',imageMime:'image/jpeg'}; S.imageBase64=null");
  app.context.resumeDraft();
  assert.equal(app.run('S.imageBase64'), '/9j/AA==');
  assert.equal(app.elements.get('uploadPreview').style.display, 'block');
  assert.equal(app.elements.get('s1').classList.contains('active'), true);
});
