'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fakeMessage, fakeThread, decodeDraft, sendAttempts, SOURCE } = require('./harness');

const READY = { ANTHROPIC_API_KEY: 'test-key-not-real', VOICE_PROFILE: 'Short, warm, signs off "Best, Alex".' };

function run(thread, opts = {}) {
  const env = load(Object.assign({ reply: 'Sounds good, what works on your end?\n\nBest,\nAlex' }, opts));
  env.ctx.processThread(thread, READY.ANTHROPIC_API_KEY, READY.VOICE_PROFILE, env.label);
  return env;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('extractEmail pulls the address out of a display-name From header', () => {
  const { ctx } = load();
  assert.equal(ctx.extractEmail('Jamie Example <jamie@example.org>'), 'jamie@example.org');
  assert.equal(ctx.extractEmail('"Example, Jamie" <JAMIE@Example.org>'), 'JAMIE@Example.org');
  assert.equal(ctx.extractEmail('  bare@example.org  '), 'bare@example.org');
});

test('hasNewsletterHeaders flags bulk, list and calendar mail', () => {
  const { ctx } = load();
  const flagged = [
    'List-Unsubscribe: <mailto:unsub@lists.example.org>',
    'Precedence: bulk', 'precedence:list', 'Precedence:  junk',
    'X-Auto-Response-Suppress: All',
    'X-Mailer: MailChimp Mailer',
    'X-Mailer: SendGrid',
    'Content-Type: text/calendar; method=REQUEST',
  ];
  for (const header of flagged) {
    assert.equal(ctx.hasNewsletterHeaders('From: a@example.org\r\n' + header + '\r\n\r\nbody'), true, header);
  }
  assert.equal(ctx.hasNewsletterHeaders('From: a@example.org\r\nPrecedence: first-class\r\n\r\nHi'), false);
  assert.equal(ctx.hasNewsletterHeaders('From: a@example.org\r\nX-Mailer: Apple Mail\r\n\r\nHi'), false);
});

test('extractHeader is case-insensitive and anchored to the start of a line', () => {
  const { ctx } = load();
  const raw = 'X-Original-Message-ID: <wrong@example.org>\r\nmessage-id:   <right@example.org>  \r\n\r\nbody';
  assert.equal(ctx.extractHeader(raw, 'Message-ID'), '<right@example.org>');
  assert.equal(ctx.extractHeader('Subject: hi\r\n\r\nbody', 'Message-ID'), null);
});

test('buildThreadContext keeps the last five messages and truncates each body', () => {
  const { ctx, CONFIG } = load();
  assert.equal(CONFIG.MAX_THREAD_MESSAGES, 5);
  const messages = Array.from({ length: 7 }, (_, i) =>
    fakeMessage({ from: `Sender ${i} <s${i}@example.org>`, body: i === 6 ? 'x'.repeat(2500) : `body ${i}` }));
  messages[3] = fakeMessage({ from: 'Sender 3 <s3@example.org>', body: null });

  const out = ctx.buildThreadContext(messages);
  const blocks = out.split(/\n\n(?=--- Message )/);
  assert.equal(blocks.length, 5);
  assert.ok(!out.includes('Sender 0') && !out.includes('Sender 1'));
  assert.match(blocks[0], /^--- Message 1 \(.+\) from Sender 2 <s2@example.org> ---\nbody 2$/);
  assert.match(blocks[1], /from Sender 3 <s3@example.org> ---\n$/); // null body becomes empty
  assert.equal(blocks[4].split('\n')[1].length, 2000);
});

test('buildSystemPrompt carries the voice profile, identity and SKIP rules', () => {
  const { ctx, CONFIG } = load();
  const prompt = ctx.buildSystemPrompt('VOICE-PROFILE-MARKER');
  assert.ok(prompt.includes('VOICE-PROFILE-MARKER'));
  assert.ok(prompt.startsWith(`You are an AI assistant drafting email replies as ${CONFIG.MY_NAME}, ${CONFIG.MY_ROLE}.`));
  assert.ok(prompt.includes(`Cold sales outreach or pitches unrelated to ${CONFIG.MY_INDUSTRY}`));
  assert.ok(prompt.includes('WHEN TO OUTPUT "SKIP"'));
  assert.ok(prompt.includes('Include a subject line in your output'));
});

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

test('generateDraft sends a well-formed Messages API request and returns the text', () => {
  const env = load({ reply: 'Draft body' });
  const text = env.ctx.generateDraft('test-key-not-real', 'VOICE', 'jamie@example.org', 'Jamie <jamie@example.org>',
    'Quick question', '--- Message 1 ---\nearlier', 'Can we meet?');
  assert.equal(text, 'Draft body');

  assert.equal(env.fetches.length, 1);
  const { url, options } = env.fetches[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(options.method, 'post');
  assert.equal(options.muteHttpExceptions, true);
  assert.equal(options.headers['x-api-key'], 'test-key-not-real');
  assert.equal(options.headers['anthropic-version'], '2023-06-01');

  const payload = JSON.parse(options.payload);
  assert.equal(payload.model, env.CONFIG.MODEL);
  assert.equal(payload.max_tokens, env.CONFIG.MAX_TOKENS_DRAFT);
  assert.ok(payload.system.includes('VOICE'));
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].role, 'user');
  const user = payload.messages[0].content;
  assert.ok(user.includes('FROM: Jamie <jamie@example.org> (jamie@example.org)'));
  assert.ok(user.includes('SUBJECT: Quick question'));
  assert.ok(user.includes('--- Message 1 ---\nearlier'));
  assert.ok(user.includes('NEW MESSAGE TO REPLY TO:\nCan we meet?'));
  assert.ok(user.includes('respond with exactly "SKIP"'));
});

test('generateDraft notes a first message and caps the new body at 4000 chars', () => {
  const env = load({ reply: 'ok' });
  env.ctx.generateDraft('k', 'V', 'a@example.org', 'a@example.org', 'S', '', 'y'.repeat(5000));
  const user = JSON.parse(env.fetches[0].options.payload).messages[0].content;
  assert.ok(user.includes('(This is the first message — no prior thread context)'));
  assert.ok(user.includes('y'.repeat(4000) + '\n'));
  assert.ok(!user.includes('y'.repeat(4001)));
});

test('generateDraft throws on a non-200 response', () => {
  const env = load({ status: 529 });
  assert.throws(
    () => env.ctx.generateDraft('k', 'V', 'a@example.org', 'a', 'S', '', 'body'),
    /Anthropic API error \(529\)/,
  );
});

// ---------------------------------------------------------------------------
// processThread: filters
// ---------------------------------------------------------------------------

const FILTERED = [
  ['mail from my own address (any case)', { from: 'Alex <YOU@Example.com>' }, 'sent by me'],
  ['a no-reply sender', { from: 'Example Service <no-reply@service.example.net>' }, 'matches sender pattern "no-reply@"'],
  ['a newsletter sender', { from: 'newsletter@example.org' }, 'matches sender pattern "newsletter@"'],
  ['a bulk-mail domain, including subdomains', { from: 'promo@bounce.mailgun.org' }, 'matches domain pattern "mailgun.org"'],
  ['a List-Unsubscribe header', { raw: 'From: x@example.org\r\nList-Unsubscribe: <mailto:u@example.org>\r\n\r\nhi' },
    'newsletter/bulk headers'],
];

for (const [name, msgOpts, reason] of FILTERED) {
  test(`processThread labels and skips ${name} without calling Claude`, () => {
    const thread = fakeThread([fakeMessage(msgOpts)]);
    const env = run(thread);
    assert.equal(env.fetches.length, 0);
    assert.equal(env.drafts.length, 0);
    assert.deepEqual(thread.labels, [env.label]);
    assert.ok(env.logs.some((l) => l.includes('Skipping: ' + reason)), env.logs.join('\n'));
  });
}

test('processThread judges the LATEST message in the thread', () => {
  // The thread started with a newsletter sender, but a person has now replied.
  const thread = fakeThread([fakeMessage({ from: 'news@example.org' }), fakeMessage({ from: 'Pat <pat@example.org>' })]);
  const env = run(thread);
  assert.equal(env.fetches.length, 1);
  assert.equal(env.drafts.length, 1);
});

test('processThread creates no draft when Claude answers SKIP (whitespace tolerated) or nothing', () => {
  for (const reply of ['SKIP', '  SKIP\n', '']) {
    const thread = fakeThread([fakeMessage()]);
    const env = run(thread, { reply });
    assert.equal(env.fetches.length, 1, JSON.stringify(reply));
    assert.equal(env.drafts.length, 0, JSON.stringify(reply));
    assert.deepEqual(thread.labels, [env.label]);
  }
});

// ---------------------------------------------------------------------------
// processThread: the draft
// ---------------------------------------------------------------------------

test('processThread creates a threaded reply draft with the Claude text', () => {
  const thread = fakeThread([fakeMessage({ subject: 'Quick question' })], { id: 'thread-42' });
  const env = run(thread, { reply: 'Happy to. What works on your end?\n\nBest,\nAlex' });

  assert.equal(env.drafts.length, 1);
  const draft = env.drafts[0];
  assert.equal(draft.userId, 'me');
  assert.equal(draft.resource.message.threadId, 'thread-42');
  assert.ok(!draft.resource.message.raw.includes('='), 'raw must be unpadded');
  assert.match(draft.resource.message.raw, /^[A-Za-z0-9_-]+$/, 'raw must be web-safe base64');

  const { headers, body } = decodeDraft(draft);
  assert.equal(headers.To, 'jamie@example.org');
  assert.equal(headers.Subject, 'Re: Quick question');
  assert.equal(headers['Content-Type'], 'text/plain; charset=UTF-8');
  assert.equal(headers['In-Reply-To'], '<abc123@mail.example.org>');
  assert.equal(headers.References, '<abc123@mail.example.org>');
  assert.equal(body, 'Happy to. What works on your end?\n\nBest,\nAlex');
  assert.deepEqual(thread.labels, [env.label]);
});

test('a subject that already starts with "Re:" is not prefixed twice', () => {
  const env = run(fakeThread([fakeMessage({ subject: 'Re: Quick question' })]));
  assert.equal(decodeDraft(env.drafts[0]).headers.Subject, 'Re: Quick question');
});

test('a message without a Message-ID still drafts, just without threading headers', () => {
  const env = run(fakeThread([fakeMessage({ raw: 'From: jamie@example.org\r\nSubject: Hi\r\n\r\nHello' })]));
  const { headers } = decodeDraft(env.drafts[0]);
  assert.equal(headers['In-Reply-To'], undefined);
  assert.equal(headers.References, undefined);
});

test('the raw draft is unpadded base64url whatever the message length', () => {
  // Three bodies cover all three length residues, so at least two would carry "=" padding.
  for (const reply of ['a', 'ab', 'abc']) {
    const env = run(fakeThread([fakeMessage()]), { reply });
    const raw = env.drafts[0].resource.message.raw;
    assert.match(raw, /^[A-Za-z0-9_-]+$/, reply);
    assert.equal(decodeDraft(env.drafts[0]).body, reply);
  }
});

test('non-ASCII draft text survives the base64url round trip', () => {
  const env = run(fakeThread([fakeMessage()]), { reply: 'Merci — à bientôt ✓' });
  assert.equal(decodeDraft(env.drafts[0]).body, 'Merci — à bientôt ✓');
});

// ---------------------------------------------------------------------------
// "Never send" guarantee
// ---------------------------------------------------------------------------

test('the source never calls a Gmail send, reply or forward API', () => {
  const code = SOURCE.replace(/\/\/.*$/gm, ''); // ignore comments
  for (const pattern of [/sendEmail\s*\(/, /\.send\s*\(/, /\.reply(All)?\s*\(/, /\.forward\s*\(/,
    /Messages\s*\.\s*send/, /Drafts\s*\.\s*send/]) {
    assert.doesNotMatch(code, pattern);
  }
  assert.match(code, /Gmail\.Users\.Drafts\.create\(/);
});

test('a full run over mixed threads only ever creates drafts', () => {
  const threads = [
    fakeThread([fakeMessage()], { id: 't-person' }),
    fakeThread([fakeMessage({ from: 'noreply@example.org' })], { id: 't-noreply' }),
    fakeThread([fakeMessage({ from: 'Robin <robin@example.org>' })], { id: 't-skip' }),
  ];
  const env = load({
    properties: READY, threads,
    reply: (url, options) => (JSON.parse(options.payload).messages[0].content.includes('robin@') ? 'SKIP' : 'Sure.'),
  });
  env.ctx.processNewEmails();
  assert.deepEqual(sendAttempts, []);
  assert.deepEqual(env.drafts.map((d) => d.resource.message.threadId), ['t-person']);
  for (const t of threads) assert.equal(t.labels.length, 1);
});

// ---------------------------------------------------------------------------
// processNewEmails orchestration
// ---------------------------------------------------------------------------

test('processNewEmails does nothing without an API key or a voice profile', () => {
  for (const properties of [{ VOICE_PROFILE: 'v' }, { ANTHROPIC_API_KEY: 'k' }]) {
    const env = load({ properties, threads: [fakeThread([fakeMessage()])] });
    env.ctx.processNewEmails();
    assert.equal(env.searches.length, 0);
    assert.equal(env.fetches.length, 0);
    assert.ok(env.logs[0].startsWith('ERROR'));
  }
});

test('processNewEmails creates the label and searches only unhandled inbox mail', () => {
  const env = load({ properties: READY, labelExists: false });
  env.ctx.processNewEmails();
  assert.equal(env.label.created, true);
  assert.deepEqual(env.searches[0], {
    query: 'is:unread -label:AI-Processed -in:sent -in:drafts -in:spam -in:trash', start: 0, max: 10,
  });
  assert.ok(env.logs.includes('No new emails to process.'));
});

test('a thread that throws is still labelled and the run continues', () => {
  const bad = fakeThread([fakeMessage()], { id: 't-bad' });
  const good = fakeThread([fakeMessage()], { id: 't-good' });
  let calls = 0;
  const env = load({
    properties: READY, threads: [bad, good],
    reply: () => { calls += 1; if (calls === 1) throw new Error('network down'); return 'Sure.'; },
  });
  env.ctx.processNewEmails();
  assert.equal(bad.labels.length, 1);
  assert.equal(good.labels.length, 1);
  assert.deepEqual(env.drafts.map((d) => d.resource.message.threadId), ['t-good']);
  assert.ok(env.logs.some((l) => l.includes('network down')));
});

// ---------------------------------------------------------------------------
// Voice training and utilities
// ---------------------------------------------------------------------------

function sentThread(n, from = 'Alex <you@example.com>') {
  return fakeThread(Array.from({ length: n }, (_, i) =>
    fakeMessage({ from, to: `client${i}@example.org`, subject: `S${i}`, body: `sent body ${i}` })));
}

test('trainVoice learns only from my own messages and stores the profile', () => {
  const mixed = fakeThread([
    fakeMessage({ from: 'Alex <YOU@example.com>', body: 'z'.repeat(2000) }),
    fakeMessage({ from: 'Someone Else <other@example.org>', body: 'NOT-MINE' }),
  ]);
  const env = load({ properties: { ANTHROPIC_API_KEY: 'k' }, threads: [mixed], reply: 'PROFILE TEXT' });
  env.ctx.trainVoice();

  assert.deepEqual(env.searches[0], { query: 'in:sent', start: 0, max: 100 });
  const payload = JSON.parse(env.fetches[0].options.payload);
  assert.equal(payload.max_tokens, env.CONFIG.MAX_TOKENS_VOICE);
  const prompt = payload.messages[0].content;
  assert.ok(prompt.startsWith('Analyze the following 1 emails sent by Alex (you@example.com)'));
  assert.ok(!prompt.includes('NOT-MINE'));
  assert.ok(prompt.includes('z'.repeat(1500)) && !prompt.includes('z'.repeat(1501)));
  assert.equal(env.props.VOICE_PROFILE, 'PROFILE TEXT');
});

test('trainVoice samples at most 50 emails into the prompt', () => {
  const env = load({ properties: { ANTHROPIC_API_KEY: 'k' }, threads: [sentThread(30), sentThread(30)], reply: 'P' });
  env.ctx.trainVoice();
  const prompt = JSON.parse(env.fetches[0].options.payload).messages[0].content;
  assert.ok(prompt.startsWith('Analyze the following 50 emails'));
  assert.ok(prompt.includes('--- Email 50 ---'));
  assert.ok(!prompt.includes('--- Email 51 ---'));
});

test('trainVoice keeps the old profile when the API fails', () => {
  const env = load({ properties: { ANTHROPIC_API_KEY: 'k', VOICE_PROFILE: 'OLD' }, threads: [sentThread(2)], status: 500 });
  env.ctx.trainVoice();
  assert.equal(env.props.VOICE_PROFILE, 'OLD');
  assert.ok(env.logs.some((l) => l.startsWith('ERROR: Anthropic API error (500)')));
});

test('clearProcessedLabel removes the label from every labelled thread', () => {
  const a = fakeThread([fakeMessage()]);
  const b = fakeThread([fakeMessage()]);
  const env = load({ labelThreads: [a, b] });
  a.addLabel(env.label);
  b.addLabel(env.label);
  env.ctx.clearProcessedLabel();
  assert.equal(a.labels.length, 0);
  assert.equal(b.labels.length, 0);
});
