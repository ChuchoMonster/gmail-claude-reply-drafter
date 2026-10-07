// ============================================================
// Gmail + Claude Reply Drafter (Google Apps Script)
// Auto-drafts replies to incoming emails in your own voice
// using Anthropic Claude. Never sends — only creates drafts.
// ============================================================

// --------------- CONFIGURATION ---------------

const CONFIG = {
  // Label applied to processed emails so we don't re-process them
  PROCESSED_LABEL: 'AI-Processed',

  // Max thread messages to include as context
  MAX_THREAD_MESSAGES: 5,

  // Max sent emails to analyze for voice training
  VOICE_TRAINING_EMAIL_COUNT: 100,

  // Anthropic model
  MODEL: 'claude-sonnet-4-20250514',

  // Max tokens for draft generation
  MAX_TOKENS_DRAFT: 1024,

  // Max tokens for voice training analysis
  MAX_TOKENS_VOICE: 4096,

  // Your email address (the Gmail account this script runs under)
  MY_EMAIL: 'you@example.com',

  // Your first name — used in the prompt and as the sign-off
  MY_NAME: 'Alex',

  // One line describing you and your work. Gives Claude context for what's relevant.
  MY_ROLE: 'an editor at a B2B trade publication covering a niche industry',

  // Your industry/beat. Pitches unrelated to this get SKIPped.
  MY_INDUSTRY: 'your industry',

  // Sender patterns to always skip (no draft needed)
  SKIP_SENDER_PATTERNS: [
    'noreply@', 'no-reply@', 'no_reply@',
    'notifications@', 'notification@',
    'marketing@', 'newsletter@', 'news@',
    'mailer-daemon@', 'postmaster@',
    'updates@', 'digest@', 'alerts@',
    'support@', // automated support systems
    'feedback@',
    'donotreply@', 'do-not-reply@',
  ],

  // Domain patterns to always skip
  SKIP_DOMAIN_PATTERNS: [
    'mailchimp.com', 'sendgrid.net', 'constantcontact.com',
    'hubspot.com', 'mailgun.org', 'amazonses.com',
    'google.com', // Google notifications
    'facebookmail.com', 'linkedin.com',
    'twitter.com', 'x.com',
  ],
};


// --------------- MAIN FUNCTION (runs on trigger) ---------------

function processNewEmails() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    Logger.log('ERROR: ANTHROPIC_API_KEY not set. Go to Project Settings > Script Properties.');
    return;
  }

  const voiceProfile = PropertiesService.getScriptProperties().getProperty('VOICE_PROFILE');
  if (!voiceProfile) {
    Logger.log('ERROR: Voice profile not generated yet. Run trainVoice() first.');
    return;
  }

  // Ensure the processed label exists
  let label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!label) {
    label = GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
  }

  // Find unread emails not yet processed
  const threads = GmailApp.search('is:unread -label:' + CONFIG.PROCESSED_LABEL + ' -in:sent -in:drafts -in:spam -in:trash', 0, 10);

  if (threads.length === 0) {
    Logger.log('No new emails to process.');
    return;
  }

  Logger.log('Found ' + threads.length + ' threads to process.');

  for (const thread of threads) {
    try {
      processThread(thread, apiKey, voiceProfile, label);
    } catch (error) {
      Logger.log('ERROR processing thread "' + thread.getFirstMessageSubject() + '": ' + error.message);
      // Label it anyway so we don't retry forever on a broken email
      thread.addLabel(label);
    }
  }
}


// --------------- PROCESS A SINGLE THREAD ---------------

function processThread(thread, apiKey, voiceProfile, label) {
  const messages = thread.getMessages();
  const latestMessage = messages[messages.length - 1];

  // Get sender info
  const from = latestMessage.getFrom();
  const senderEmail = extractEmail(from);
  const subject = latestMessage.getSubject();

  Logger.log('Processing: "' + subject + '" from ' + senderEmail);

  // --- Filter 1: Skip emails from myself ---
  if (senderEmail.toLowerCase() === CONFIG.MY_EMAIL.toLowerCase()) {
    Logger.log('  Skipping: sent by me');
    thread.addLabel(label);
    return;
  }

  // --- Filter 2: Skip known no-reply / automated senders ---
  const senderLower = senderEmail.toLowerCase();
  for (const pattern of CONFIG.SKIP_SENDER_PATTERNS) {
    if (senderLower.includes(pattern)) {
      Logger.log('  Skipping: matches sender pattern "' + pattern + '"');
      thread.addLabel(label);
      return;
    }
  }

  // --- Filter 3: Skip known bulk/marketing domains ---
  const senderDomain = senderLower.split('@')[1] || '';
  for (const domain of CONFIG.SKIP_DOMAIN_PATTERNS) {
    if (senderDomain.includes(domain)) {
      Logger.log('  Skipping: matches domain pattern "' + domain + '"');
      thread.addLabel(label);
      return;
    }
  }

  // --- Filter 4: Check for newsletter/bulk headers ---
  const rawContent = latestMessage.getRawContent();
  if (hasNewsletterHeaders(rawContent)) {
    Logger.log('  Skipping: newsletter/bulk headers detected');
    thread.addLabel(label);
    return;
  }

  // --- Build thread context (last N messages) ---
  const threadContext = buildThreadContext(messages);

  // --- Call Claude to generate draft ---
  const draftText = generateDraft(apiKey, voiceProfile, senderEmail, from, subject, threadContext, latestMessage.getPlainBody());

  if (!draftText || draftText.trim() === 'SKIP') {
    Logger.log('  AI said SKIP — no draft needed');
    thread.addLabel(label);
    return;
  }

  // --- Create draft reply in the thread ---
  createDraftReply(thread, latestMessage, senderEmail, subject, draftText);

  Logger.log('  Draft created successfully');
  thread.addLabel(label);
}


// --------------- FILTER HELPERS ---------------

function extractEmail(fromField) {
  // Extract email from "Name <email@example.com>" or just "email@example.com"
  const match = fromField.match(/<([^>]+)>/);
  return match ? match[1] : fromField.trim();
}

function hasNewsletterHeaders(rawContent) {
  const headerSection = rawContent.substring(0, Math.min(rawContent.length, 5000));
  const checks = [
    /List-Unsubscribe:/i,
    /Precedence:\s*(bulk|list|junk)/i,
    /X-Auto-Response-Suppress:/i,
    /X-Mailer:.*mailchimp/i,
    /X-Mailer:.*sendgrid/i,
    /Content-Type:.*text\/calendar/i,
  ];

  for (const check of checks) {
    if (check.test(headerSection)) {
      return true;
    }
  }
  return false;
}


// --------------- THREAD CONTEXT BUILDER ---------------

function buildThreadContext(messages) {
  // Take last N messages for context
  const contextMessages = messages.slice(-CONFIG.MAX_THREAD_MESSAGES);

  return contextMessages.map((msg, i) => {
    const from = msg.getFrom();
    const date = msg.getDate().toLocaleDateString();
    const body = (msg.getPlainBody() || '').substring(0, 2000); // Truncate long messages
    return `--- Message ${i + 1} (${date}) from ${from} ---\n${body}`;
  }).join('\n\n');
}


// --------------- CLAUDE API CALL ---------------

function generateDraft(apiKey, voiceProfile, senderEmail, senderName, subject, threadContext, newMessageBody) {
  const systemPrompt = buildSystemPrompt(voiceProfile);

  const userPrompt = `New email received that may need a reply.

FROM: ${senderName} (${senderEmail})
SUBJECT: ${subject}

THREAD CONTEXT (previous messages in this conversation):
${threadContext || '(This is the first message — no prior thread context)'}

NEW MESSAGE TO REPLY TO:
${(newMessageBody || '').substring(0, 4000)}

---
Draft a reply as ${CONFIG.MY_NAME}, or respond with exactly "SKIP" if no reply is needed.`;

  const payload = {
    model: CONFIG.MODEL,
    max_tokens: CONFIG.MAX_TOKENS_DRAFT,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userPrompt }
    ]
  };

  const options = {
    method: 'post',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  const responseCode = response.getResponseCode();

  if (responseCode !== 200) {
    throw new Error('Anthropic API error (' + responseCode + '): ' + response.getContentText());
  }

  const result = JSON.parse(response.getContentText());
  return result.content[0].text;
}


// --------------- SYSTEM PROMPT ---------------

function buildSystemPrompt(voiceProfile) {
  const name = CONFIG.MY_NAME;
  return `You are an AI assistant drafting email replies as ${name}, ${CONFIG.MY_ROLE}.

YOUR TASK: Draft a reply to the incoming email in ${name}'s voice. Output ONLY the reply body text — no subject line, no metadata, no explanations.

VOICE PROFILE (learned from ${name}'s actual sent emails):
${voiceProfile}

RULES:
1. Match ${name}'s tone exactly, as described in the voice profile (formality, punctuation habits, use of bullet points for multiple items).
2. Sign off with "Best,\\n${name}" unless it's a quick back-and-forth where sign-offs aren't needed.
3. Reply length should match the complexity of the email — 1-2 sentences for simple things, a short paragraph for complex topics.
4. For scheduling requests: put the ball in the other person's court ("What works on your end?").
5. For customer issues (password resets, refunds, subscription questions): be helpful and action-oriented.
6. For internal team emails from colleagues: be direct and collaborative.
7. For forwarded customer conversations from teammates: reply with context about what to do.
8. For interview / Q&A requests: assume the sender is in ${CONFIG.MY_INDUSTRY} — don't ask about their business. Ask what topics they'd like to cover and say you'll draft a list of questions and send it back. Interviews are done over email, not calls, so don't propose a time.

WHEN TO OUTPUT "SKIP" (just the word, nothing else):
- Cold sales outreach or pitches unrelated to ${CONFIG.MY_INDUSTRY}
- Generic PR pitches not relevant to ${CONFIG.MY_INDUSTRY}
- Emails that are purely informational with no action needed (shipping confirmations, receipts, etc.)
- Mass emails that slipped through filters
- Emails where ${name} is CC'd but not the primary recipient and no action is needed from them

NEVER:
- Include a subject line in your output
- Add meta-commentary like "Here's a draft:" — just output the reply text
- Make up facts, commitments, or dates ${name} hasn't agreed to
- Promise specific actions unless the email clearly requires them
- Be overly formal or stiff unless the voice profile says otherwise`;
}


// --------------- CREATE DRAFT REPLY ---------------

function createDraftReply(thread, originalMessage, toEmail, subject, bodyText) {
  // Build the MIME message for the draft
  const replySubject = subject.startsWith('Re:') ? subject : 'Re: ' + subject;
  const messageId = originalMessage.getId();
  const threadId = thread.getId();

  // Get the Message-ID header for proper threading
  const rawContent = originalMessage.getRawContent();
  const messageIdHeader = extractHeader(rawContent, 'Message-ID') || extractHeader(rawContent, 'Message-Id');

  // Build MIME message
  let mimeMessage = '';
  mimeMessage += 'To: ' + toEmail + '\r\n';
  mimeMessage += 'Subject: ' + replySubject + '\r\n';
  mimeMessage += 'Content-Type: text/plain; charset=UTF-8\r\n';
  if (messageIdHeader) {
    mimeMessage += 'In-Reply-To: ' + messageIdHeader + '\r\n';
    mimeMessage += 'References: ' + messageIdHeader + '\r\n';
  }
  mimeMessage += '\r\n';
  mimeMessage += bodyText;

  // Encode to base64url (strip padding — Gmail API requires no padding)
  const encodedMessage = Utilities.base64EncodeWebSafe(mimeMessage).replace(/=+$/, '');

  // Create draft using Gmail Advanced Service
  const draft = Gmail.Users.Drafts.create(
    {
      message: {
        raw: encodedMessage,
        threadId: threadId,
      }
    },
    'me'
  );

  return draft;
}

function extractHeader(rawContent, headerName) {
  const regex = new RegExp('^' + headerName + ':\\s*(.+)$', 'mi');
  const match = rawContent.match(regex);
  return match ? match[1].trim() : null;
}


// ============================================================
// VOICE TRAINING — Run this ONCE to build the voice profile
// ============================================================

function trainVoice() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    Logger.log('ERROR: ANTHROPIC_API_KEY not set. Go to Project Settings > Script Properties.');
    return;
  }

  Logger.log('Fetching sent emails for voice analysis...');

  // Pull sent emails
  const threads = GmailApp.search('in:sent', 0, CONFIG.VOICE_TRAINING_EMAIL_COUNT);

  const sentEmails = [];
  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const msg of messages) {
      const from = extractEmail(msg.getFrom());
      if (from.toLowerCase() === CONFIG.MY_EMAIL.toLowerCase()) {
        sentEmails.push({
          to: msg.getTo(),
          subject: msg.getSubject(),
          body: (msg.getPlainBody() || '').substring(0, 1500), // Truncate long emails
          date: msg.getDate().toLocaleDateString(),
        });
      }
    }
    if (sentEmails.length >= CONFIG.VOICE_TRAINING_EMAIL_COUNT) break;
  }

  Logger.log('Found ' + sentEmails.length + ' sent emails. Analyzing with Claude...');

  // Format emails for analysis (keep it under token limits)
  // Send in batches if needed — start with first 50
  const emailSample = sentEmails.slice(0, 50).map((e, i) => {
    return `--- Email ${i + 1} ---
To: ${e.to}
Subject: ${e.subject}
Date: ${e.date}
Body:
${e.body}`;
  }).join('\n\n');

  const analysisPrompt = `Analyze the following ${Math.min(sentEmails.length, 50)} emails sent by ${CONFIG.MY_NAME} (${CONFIG.MY_EMAIL}), ${CONFIG.MY_ROLE}.

Create a detailed VOICE PROFILE that captures:

1. **Overall Tone**: How formal/casual, warm/distant, direct/diplomatic
2. **Common Phrases & Expressions**: Exact phrases they repeatedly use (greetings, sign-offs, transitions, acknowledgments)
3. **Email Structure Patterns**: How they start emails, structures the body, and ends them
4. **Response Length Patterns**: When they write short vs. long replies
5. **Punctuation & Formatting Habits**: Use of exclamation points, ellipses, bullet points, caps, emojis, etc.
6. **Tone Shifts by Context**: How their tone changes for different types of emails (internal team, external contacts, customer requests, etc.)
7. **Decision-Making Language**: How they agree, decline, defer, or delegate
8. **Personality Markers**: Any humor, directness, warmth, or unique stylistic choices

Be very specific — include actual example phrases from the emails. This profile will be used to generate draft replies that sound exactly like ${CONFIG.MY_NAME}.

EMAILS:
${emailSample}`;

  const payload = {
    model: CONFIG.MODEL,
    max_tokens: CONFIG.MAX_TOKENS_VOICE,
    messages: [
      { role: 'user', content: analysisPrompt }
    ]
  };

  const options = {
    method: 'post',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  const responseCode = response.getResponseCode();

  if (responseCode !== 200) {
    Logger.log('ERROR: Anthropic API error (' + responseCode + '): ' + response.getContentText());
    return;
  }

  const result = JSON.parse(response.getContentText());
  const voiceProfile = result.content[0].text;

  // Store the voice profile
  PropertiesService.getScriptProperties().setProperty('VOICE_PROFILE', voiceProfile);

  Logger.log('Voice profile generated and saved successfully!');
  Logger.log('--- VOICE PROFILE ---');
  Logger.log(voiceProfile);
  Logger.log('--- END PROFILE ---');
  Logger.log('You can now set up the time trigger for processNewEmails().');
}


// ============================================================
// UTILITY: View the current voice profile
// ============================================================

function viewVoiceProfile() {
  const profile = PropertiesService.getScriptProperties().getProperty('VOICE_PROFILE');
  if (profile) {
    Logger.log('Current voice profile:\n' + profile);
  } else {
    Logger.log('No voice profile found. Run trainVoice() first.');
  }
}


// ============================================================
// UTILITY: Clear the processed label (reprocess all emails)
// ============================================================

function clearProcessedLabel() {
  const label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!label) {
    Logger.log('Label "' + CONFIG.PROCESSED_LABEL + '" does not exist.');
    return;
  }

  const threads = label.getThreads();
  Logger.log('Removing label from ' + threads.length + ' threads...');

  for (const thread of threads) {
    thread.removeLabel(label);
  }

  Logger.log('Done. All emails will be reprocessed on next run.');
}


// ============================================================
// UTILITY: Test on a single email (pass a thread search query)
// ============================================================

function testOnSingleEmail() {
  // Change this search query to target a specific email for testing
  const testQuery = 'is:unread -label:AI-Processed subject:"test"';

  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  const voiceProfile = PropertiesService.getScriptProperties().getProperty('VOICE_PROFILE');

  if (!apiKey || !voiceProfile) {
    Logger.log('ERROR: API key or voice profile not set.');
    return;
  }

  const threads = GmailApp.search(testQuery, 0, 1);
  if (threads.length === 0) {
    Logger.log('No emails found matching: ' + testQuery);
    return;
  }

  const label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL) || GmailApp.createLabel(CONFIG.PROCESSED_LABEL);

  processThread(threads[0], apiKey, voiceProfile, label);
  Logger.log('Test complete. Check your Gmail drafts.');
}
