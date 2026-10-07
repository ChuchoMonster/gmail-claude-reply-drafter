# Gmail + Claude Reply Drafter

A Google Apps Script that reads new Gmail messages and has Claude write a reply **draft** in your
own voice. It never sends anything: drafts land in the thread for you to review, edit and send.

## What it does

- Runs every minute on a time-driven trigger.
- Finds unread threads that haven't been handled yet.
- Filters out mail that never needs a reply (no-reply senders, bulk-mail domains, newsletter
  headers such as `List-Unsubscribe` / `Precedence: bulk`, calendar invites).
- Sends the latest message plus up to 5 prior messages of thread context to Claude, along with a
  **voice profile** learned from your own sent mail.
- Claude returns either a reply body or the literal word `SKIP` (cold pitches, receipts, CCs that
  need no action, etc.).
- The draft is created inside the original thread with correct `In-Reply-To` / `References`
  headers, and the thread is labelled `AI-Processed` so it's never handled twice.

## How it works

```
time trigger -> processNewEmails()
                  |- GmailApp.search(unread, not AI-Processed)
                  |- rule-based filters (sender, domain, raw headers)
                  |- buildThreadContext()            last N messages, truncated
                  |- generateDraft()                 Anthropic Messages API via UrlFetchApp
                  |- createDraftReply()              MIME message -> Gmail API Drafts.create(threadId)
                  '- label thread AI-Processed
```

**Voice training.** `trainVoice()` pulls up to 100 of your sent emails, sends a sample of 50 to
Claude and asks for a structured style profile (tone, recurring phrases, structure, length habits,
punctuation, how tone shifts by audience, how you agree/decline/defer). The profile is stored in
Script Properties and injected into every drafting prompt. Re-run it whenever your style drifts.

**Why the Gmail Advanced Service.** `GmailApp` can't reliably create a draft attached to an
existing thread, so drafts are built as raw MIME, base64url-encoded, and created with
`Gmail.Users.Drafts.create` using the thread ID.

**Failure handling.** If a thread throws, it is still labelled so a single malformed email can't
cause an infinite retry loop.

## Stack

- Google Apps Script (V8 runtime), `GmailApp`, Gmail Advanced Service, `UrlFetchApp`,
  `PropertiesService`
- Anthropic Messages API (`CONFIG.MODEL`, set to a Claude Sonnet model)

## Setup

Full click-by-click instructions are in [SETUP.md](SETUP.md). In short:

1. Create a new Apps Script project while signed in to the target Gmail account and paste in
   `reply-drafter.js`.
2. Edit `CONFIG` at the top: `MY_EMAIL`, `MY_NAME`, `MY_ROLE`, `MY_INDUSTRY`, and optionally the
   skip lists and model.
3. Add Script Properties (Project Settings -> Script Properties):

   | Property | Value |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | your Anthropic API key |
   | `VOICE_PROFILE` | written automatically by `trainVoice()`; don't set by hand |

4. Enable the **Gmail API** advanced service.
5. Run `trainVoice()` once, then `testOnSingleEmail()`.
6. Add a time-driven trigger for `processNewEmails` (every minute).

There is no `.env` file: Apps Script keeps secrets in Script Properties, not in the code.

## Utility functions

| Function | Purpose |
| --- | --- |
| `trainVoice()` | Build or rebuild the voice profile from sent mail |
| `viewVoiceProfile()` | Print the stored profile to the execution log |
| `testOnSingleEmail()` | Process one thread matching a search query |
| `clearProcessedLabel()` | Remove the label from all threads so they are reprocessed |

## Customizing

- **Filters**: `SKIP_SENDER_PATTERNS` and `SKIP_DOMAIN_PATTERNS` in `CONFIG`.
- **Behaviour rules**: the RULES / SKIP / NEVER sections in `buildSystemPrompt()`. Rule 8 is an
  example of a domain-specific rule (handling interview requests by email) — replace it with
  whatever recurring request types you get.

## Cost

Roughly 2K input + 200 output tokens per draft; a few dollars a month at typical inbox volume.
