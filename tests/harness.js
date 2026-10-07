// Loads reply-drafter.js into a fresh V8 context with fake Google Apps Script services.
// Every service that could SEND mail throws, so any test that reaches one fails loudly.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE_PATH = path.join(__dirname, '..', 'reply-drafter.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// Records every attempt to send, even ones the script's own try/catch would swallow.
const sendAttempts = [];

function forbidden(name) {
  return () => {
    sendAttempts.push(name);
    throw new Error('FORBIDDEN: ' + name + ' was called — the script must never send mail');
  };
}

function fakeMessage(opts = {}) {
  const m = {
    from: opts.from || 'Jamie Example <jamie@example.org>',
    subject: opts.subject !== undefined ? opts.subject : 'Quick question',
    body: opts.body !== undefined ? opts.body : 'Hi Alex, can we talk next week?',
    raw: opts.raw !== undefined ? opts.raw
      : 'Message-ID: <abc123@mail.example.org>\r\nFrom: jamie@example.org\r\nSubject: Quick question\r\n\r\nHi',
    to: opts.to || 'you@example.com',
    date: opts.date || new Date(Date.UTC(2026, 5, 1, 12)),
    id: opts.id || 'msg-1',
  };
  return {
    getFrom: () => m.from,
    getSubject: () => m.subject,
    getPlainBody: () => m.body,
    getRawContent: () => m.raw,
    getTo: () => m.to,
    getDate: () => m.date,
    getId: () => m.id,
    reply: forbidden('GmailMessage.reply'),
    replyAll: forbidden('GmailMessage.replyAll'),
    forward: forbidden('GmailMessage.forward'),
  };
}

function fakeThread(messages, opts = {}) {
  const t = {
    labels: [],
    getMessages: () => messages,
    getId: () => opts.id || 'thread-1',
    getFirstMessageSubject: () => (messages[0] ? messages[0].getSubject() : ''),
    addLabel: (label) => { t.labels.push(label); return t; },
    removeLabel: (label) => { t.labels = t.labels.filter((l) => l !== label); return t; },
    reply: forbidden('GmailThread.reply'),
    replyAll: forbidden('GmailThread.replyAll'),
  };
  return t;
}

// Creates a sandbox. `opts.reply` is the text the fake Claude API returns (or a function
// of the request); `opts.status` the HTTP status; `opts.threads` what GmailApp.search returns.
function load(opts = {}) {
  sendAttempts.length = 0;
  const logs = [];
  const fetches = [];
  const drafts = [];
  const searches = [];
  const props = Object.assign({}, opts.properties || {});
  const makeLabel = (name, threads, created) => ({ name, threads, created, getThreads: () => threads });
  let label = opts.labelExists === false ? null : makeLabel('AI-Processed', opts.labelThreads || [], false);

  const sandbox = {
    Logger: { log: (msg) => logs.push(String(msg)) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
      }),
    },
    GmailApp: {
      search: (query, start, max) => {
        searches.push({ query, start, max });
        return opts.threads || [];
      },
      getUserLabelByName: (name) => (label && label.name === name ? label : null),
      createLabel: (name) => { label = makeLabel(name, [], true); return label; },
      sendEmail: forbidden('GmailApp.sendEmail'),
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        fetches.push({ url, options });
        const status = opts.status || 200;
        const text = typeof opts.reply === 'function' ? opts.reply(url, options) : opts.reply;
        const body = status === 200 ? JSON.stringify({ content: [{ type: 'text', text }] })
          : JSON.stringify({ error: { message: 'overloaded' } });
        return { getResponseCode: () => status, getContentText: () => body };
      },
    },
    Utilities: {
      // Apps Script returns padded, web-safe base64.
      base64EncodeWebSafe: (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    },
    Gmail: {
      Users: {
        Drafts: {
          create: (resource, userId) => { drafts.push({ resource, userId }); return { id: 'draft-' + drafts.length }; },
          send: forbidden('Gmail.Users.Drafts.send'),
        },
        Messages: { send: forbidden('Gmail.Users.Messages.send') },
      },
    },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(SOURCE, context, { filename: 'reply-drafter.js' });
  // Top-level `const CONFIG` lives in the script scope, not on the global object.
  const CONFIG = vm.runInContext('CONFIG', context);

  return {
    ctx: context, CONFIG, logs, fetches, drafts, searches, props,
    get label() { return label; },
  };
}

// Decodes the raw MIME of a created draft back into headers + body.
function decodeDraft(draft) {
  const mime = Buffer.from(draft.resource.message.raw, 'base64url').toString('utf8');
  const [head, ...rest] = mime.split('\r\n\r\n');
  const headers = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return { mime, headers, body: rest.join('\r\n\r\n') };
}

module.exports = { load, fakeMessage, fakeThread, decodeDraft, sendAttempts, SOURCE };
