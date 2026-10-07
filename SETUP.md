# Setup Guide

## What This Does
Automatically drafts replies to incoming email in your Gmail account using Claude. Drafts appear in Gmail for you to review and send. It never sends anything on its own.

## Setup Steps (10 minutes)

### 1. Open Google Apps Script
- Go to [script.google.com](https://script.google.com) while signed in to the Gmail account you want drafts for
- Click **New Project**
- Name it "Reply Drafter" or whatever you like

### 2. Paste the Script
- Delete the default `myFunction()` code
- Copy the entire contents of `reply-drafter.js` and paste it in
- Click **Save** (Ctrl+S)

### 3. Fill in CONFIG
At the top of the script, set `MY_EMAIL`, `MY_NAME`, `MY_ROLE` and `MY_INDUSTRY`.
`MY_EMAIL` must be the account the script runs under; it is used to pick out your own sent mail
for voice training and to skip emails you sent yourself.

### 4. Add Your Anthropic API Key
- In the Apps Script editor, click the **gear icon** (Project Settings) in the left sidebar
- Scroll down to **Script Properties**
- Click **Add Script Property**
  - Property: `ANTHROPIC_API_KEY`
  - Value: your Anthropic API key (starts with `sk-ant-...`)
- Click **Save**

### 5. Enable Gmail Advanced Service
- In the left sidebar, click the **+** next to **Services**
- Scroll down and find **Gmail API**
- Click **Add**
- This enables draft creation with thread support

### 6. Run Voice Training
- In the editor, select `trainVoice` from the function dropdown at the top
- Click **Run**
- First time: Google will ask you to authorize the script. Click through:
  - "Review Permissions" → Select your Google account → "Advanced" → "Go to Reply Drafter (unsafe)" → "Allow"
  - This grants the script access to your Gmail (read + draft creation)
- Wait ~30 seconds for it to analyze your sent emails
- Check the **Execution Log** (View > Execution log) to see the voice profile output
- The profile is automatically saved — you don't need to copy it anywhere

### 7. Test on a Single Email
- Send a test email to your account from another address, with "test" in the subject
- In the function dropdown, select `testOnSingleEmail`
- Edit the search query in that function if needed (default searches for unread emails with subject "test")
- Click **Run**
- Check your Gmail drafts — you should see a draft reply in the test thread

### 8. Set Up the Automatic Trigger
- Click the **clock icon** (Triggers) in the left sidebar
- Click **+ Add Trigger**
  - Function: `processNewEmails`
  - Event source: **Time-driven**
  - Type: **Minutes timer**
  - Interval: **Every minute**
- Click **Save**
- The script will now check for new emails every minute and create draft replies automatically

## How It Works

1. Every minute, the script checks for unread emails not yet labeled "AI-Processed"
2. It filters out newsletters, automated notifications, and bulk mail
3. For emails that pass the filter, it fetches the thread conversation history
4. It sends the email + thread context to Claude with your voice profile
5. Claude either drafts a reply or says "SKIP" (for cold outreach, irrelevant PR, etc.)
6. If a draft is generated, it's saved as a Gmail draft in the same thread
7. The email gets labeled "AI-Processed" so it won't be processed again

## Customization

### Adjust Filtering
In the `CONFIG` object at the top of the script:
- `SKIP_SENDER_PATTERNS`: Add/remove sender patterns to skip
- `SKIP_DOMAIN_PATTERNS`: Add/remove domain patterns to skip

### Retrain Voice
If you want to update the voice profile (e.g., after changing your writing style):
- Run `trainVoice()` again — it overwrites the previous profile

### View Current Voice Profile
- Run `viewVoiceProfile()` to see what the AI learned about your writing

### Reprocess All Emails
- Run `clearProcessedLabel()` to remove the AI-Processed label from all emails
- Next trigger run will reprocess everything (careful — may create duplicate drafts)

## Costs
- **Google Apps Script**: Free
- **Anthropic API**: ~$3-5/month depending on email volume. Claude Sonnet at ~$3/1M input tokens and ~$15/1M output tokens. A typical email draft uses ~2K input tokens and ~200 output tokens.

## Troubleshooting
- **No drafts appearing**: Check Execution Log for errors. Most common: API key not set, or Gmail Advanced Service not enabled.
- **Drafts in wrong thread**: Rare, but can happen if Gmail thread grouping is unusual. The script uses threadId for proper threading.
- **Too many/few emails being drafted**: Adjust the filter patterns in CONFIG, or refine the SKIP rules in `buildSystemPrompt()`.
