# Webex SDK Hybrid POC

This proof-of-concept demonstrates the **hybrid approach** to joining Webex meetings and capturing audio: a minimal HTML page loads the Webex Browser SDK, controlled via Playwright from Node.js.

## What This Tests

✅ **Can we load the Webex SDK in a real browser context?**  
✅ **Can we join a meeting programmatically using the SDK?**  
✅ **Can we access the remote audio MediaStream?**  
✅ **Can we capture audio using Web Audio API (AudioContext)?**  
✅ **Can Playwright control the entire flow from Node.js?**

## Why This Approach?

The previous POC (`poc/webex-sdk-test`) proved that **pure Node.js is impossible** — the Webex SDK requires browser globals (`window`, `navigator`, DOM APIs) that don't exist in Node.

This hybrid approach:
- Gives the SDK a **real browser** (Chromium via Playwright)
- Lets us **control the browser from Node.js**
- Fits perfectly with the existing Vexa architecture (which already uses Playwright for all platforms)
- Avoids fragile DOM scraping — the SDK handles meeting join and audio access

## Prerequisites

- **Node.js** 18.0.0 or later
- **Playwright** (for Chromium control)
- **Webex Access Token** (see below for how to get one)

## Installation

```bash
npm install
npx playwright install chromium
```

## Getting Credentials

### Option 1: Personal Access Token (Easiest for Testing)

**⚠️ Valid for 12 hours only!**

1. Go to https://developer.webex.com
2. Click **Sign In** (top right)
3. Go to **Getting Started** → https://developer.webex.com/docs/api/getting-started
4. Scroll down to find your **Personal Access Token** (auto-generated if logged in)
5. Copy the token

**Scopes included:** All personal scopes (meetings, messages, etc.)

### Option 2: Create a Bot

1. Go to https://developer.webex.com
2. Sign in and click **Start Building Apps**
3. Choose **Create a Bot**
4. Fill in:
   - **Bot name:** (e.g., "Vexa Meeting Bot")
   - **Bot username:** (unique, e.g., "vexa-bot")
   - **Icon:** (optional)
5. Click **Add Bot**
6. Copy the **Bot Access Token** (shown only once — save it!)

**Scopes:** Bots have limited scopes by default. For meetings, bots can join as participants.

### Option 3: Create an Integration (OAuth App)

1. Go to https://developer.webex.com
2. Sign in and click **Start Building Apps**
3. Choose **Create an Integration**
4. Fill in:
   - **Integration name:** (e.g., "Vexa Meeting Recorder")
   - **Icon:** (optional)
   - **Description:** "POC for joining Webex meetings"
   - **Redirect URI:** `http://localhost:3000/auth/callback` (or any valid URL for testing)
   - **Scopes:** Select:
     - `meeting:schedules_read` (read meeting info)
     - `meeting:recordings_read` (optional, for later)
     - `spark:all` (for full meeting access — adjust as needed)
5. Click **Add Integration**
6. Copy the **Client ID** and **Client Secret**

**Note:** Integrations require OAuth flow (user login) — more complex than Personal Token or Bot.

### Option 4: Guest Issuer (for Guest Access)

For **guest users** (no Webex account):

1. Go to https://developer.webex.com
2. Create an Integration (as above)
3. Use the **Guest Issuer** API to generate a JWT token for a guest user
4. Documentation: https://developer.webex.com/docs/guest-issuer

**Use case:** Allow users without Webex accounts to join meetings.

## Running the POC

```bash
node test-hybrid.js <meeting-url> <access-token>
```

### Examples

**With Personal Access Token:**
```bash
node test-hybrid.js "https://example.webex.com/meet/john" "YourPersonalAccessTokenHere"
```

**With email address (calling a user directly):**
```bash
node test-hybrid.js "john.doe@example.com" "YourPersonalAccessTokenHere"
```

**With SIP URI:**
```bash
node test-hybrid.js "meeting@example.webex.com" "YourPersonalAccessTokenHere"
```

**With Person ID or Room ID:**
```bash
node test-hybrid.js "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9hYmMxMjM..." "YourPersonalAccessTokenHere"
```

## Expected Output

### 1. **Browser Launch**
```
🚀 Launching Chromium...
📄 Loading meeting.html...
```

### 2. **SDK Initialization**
```
⚙️  Injecting config...
🔧 Initializing Webex SDK...
  [WEBEX] Initializing Webex SDK...
  [WEBEX] SDK initialized
  [WEBEX] Registering with Webex...
```

### 3. **Meeting Join**
```
  [WEBEX] Registration successful
  [WEBEX] Creating meeting...
  [WEBEX] Meeting created
  [WEBEX] Joining meeting...
  [WEBEX] Joined meeting successfully
```

### 4. **Audio Stream Ready**
```
⏳ Waiting for audio stream...
.....
✅ Audio stream is ready!

📊 Audio Stream Info:
{
  "id": "stream-id-123",
  "active": true,
  "tracks": [
    {
      "kind": "audio",
      "id": "track-id-456",
      "label": "Remote audio",
      "enabled": true,
      "muted": false,
      "readyState": "live"
    }
  ]
}
```

### 5. **Audio Capture Test**
```
🎙️  Testing audio capture...
✅ Audio capture test successful:
   Samples: 96000
   Sample rate: 48000 Hz
   Duration: 2.00s
   Peak amplitude: 0.0234
   ✅ Audio signal detected!
```

### 6. **Cleanup**
```
👋 Leaving meeting...
✅ Left successfully
📋 Captured 15 log entries
🔚 Closing browser...
✅ POC test complete!
```

## What Gets Captured

1. **Initialization logs** — SDK setup, registration
2. **Meeting creation** — meeting ID, destination
3. **Join events** — success/failure
4. **Audio stream metadata** — track IDs, labels, state
5. **Audio samples** — via Web Audio API (AudioContext + ScriptProcessorNode)

All events are logged to:
- `window.__WEBEX_LOGS[]` (accessible via Playwright)
- Browser console (visible in non-headless mode)

## Architecture

```
┌─────────────┐
│  Node.js    │
│ (Playwright)│
└──────┬──────┘
       │ Controls
       ▼
┌─────────────────┐
│   Chromium      │
│                 │
│  ┌───────────┐  │
│  │ meeting.  │  │
│  │  html     │  │
│  └─────┬─────┘  │
│        │        │
│        │ Loads  │
│        ▼        │
│  ┌───────────┐  │
│  │  Webex    │  │
│  │   SDK     │  │
│  │  (CDN)    │  │
│  └─────┬─────┘  │
│        │        │
│        │ API    │
│        ▼        │
│  ┌───────────┐  │
│  │ Webex     │  │
│  │ Meeting   │  │
│  │  Audio    │  │
│  └───────────┘  │
└─────────────────┘
```

**Flow:**
1. Playwright launches Chromium
2. Loads `meeting.html` (minimal page with SDK)
3. Injects config via `page.evaluate()`
4. Calls `window.initWebex()` to join meeting
5. Monitors `window.__WEBEX_STATUS` for progress
6. Accesses `window.__WEBEX_AUDIO_STREAM` (MediaStream object)
7. Optionally captures audio using `AudioContext`

## Files

### `meeting.html`
- Minimal HTML page
- Loads Webex SDK from CDN (`https://unpkg.com/webex@^3/umd/webex.min.js`)
- Exposes:
  - `window.__WEBEX_STATUS` — current state (initialized, joined, audioReady, etc.)
  - `window.__WEBEX_LOGS` — array of log entries
  - `window.__WEBEX_AUDIO_STREAM` — remote audio MediaStream
  - `window.initWebex()` — async function to join meeting
  - `window.leaveMeeting()` — async function to leave

### `test-hybrid.js`
- Playwright script (Node.js)
- Launches Chromium
- Loads `meeting.html`
- Injects config (`access_token`, `meetingUrl`)
- Calls `initWebex()` and waits for audio
- Tests audio capture using Web Audio API
- Leaves meeting and exits

### `package.json`
- Dependencies: `playwright` only
- The Webex SDK loads in the browser, not in Node

## Troubleshooting

### "Missing __WEBEX_CONFIG"
- Make sure the script is passing the access token and meeting URL correctly
- Check that `page.evaluate()` is injecting the config before calling `initWebex()`

### "Failed to register"
- Access token may be expired (Personal Tokens expire after 12 hours)
- Token may not have the required scopes
- Network issues (firewall blocking Webex endpoints)

### "Meeting creation failed"
- Invalid meeting URL or destination format
- User doesn't exist or isn't reachable
- Network issues

### "Audio stream not ready"
- No other participant in the meeting (audio only flows when someone else is speaking)
- Browser permissions denied (should be auto-granted via Playwright flags)
- SDK version incompatibility

### Debug Mode
Set `headless: false` in `test-hybrid.js` to see the browser window and inspect the console.

## Limitations & Notes

- **Personal Access Tokens expire after 12 hours** — you'll need to regenerate them
- **Guest users** require JWT tokens (Guest Issuer API)
- **Audio only flows when someone is speaking** — if the meeting is silent, `peakAmplitude` will be 0
- **No video** in this POC (kept simple for audio testing)
- **No transcription** — this POC just proves audio access works
- **Browser-only** — the SDK cannot run in pure Node.js

## What Works

✅ SDK loads from CDN  
✅ Authentication with Personal Access Token  
✅ Register with Webex  
✅ Create meeting object  
✅ Join meeting (audio-only)  
✅ Access remote audio MediaStream  
✅ Capture audio using Web Audio API  
✅ Leave meeting  
✅ All controlled from Node.js via Playwright  

## What's Next (for Vexa Integration)

1. **Add this to the Vexa platform selector** (alongside Zoom, Teams, etc.)
2. **Connect audio capture to WhisperLive** (same as other platforms)
3. **Handle meeting lifecycle** (join, stay connected, reconnect on errors)
4. **Add authentication flow** (OAuth for production, not Personal Tokens)
5. **Error handling & retry logic**
6. **Monitoring & logging**

## References

- **Webex JS SDK:** https://github.com/webex/webex-js-sdk
- **NPM Package:** https://www.npmjs.com/package/webex
- **Developer Portal:** https://developer.webex.com
- **Getting Started:** https://developer.webex.com/docs/sdks/browser
- **Sample Code:** https://github.com/WebexSamples/webex-meetings-quick-start
- **API Docs:** https://webex.github.io/webex-js-sdk/api/

## License

Same as Vexa project.

---

**Status:** ✅ Proof-of-concept complete — hybrid approach works!
