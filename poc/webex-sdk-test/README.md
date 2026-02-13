# Webex Browser SDK POC Test

**Goal:** Test whether the Webex Browser SDK (`webex` npm package) can join meetings and access audio streams in a Node.js environment.

## 📋 Summary

This POC tests the viability of using the official Webex JavaScript SDK to:
1. Connect to Webex with a bot/guest token
2. Join a Webex meeting programmatically
3. Access remote audio MediaStreams from the meeting

## 🔑 Credentials & Setup Required

### Option 1: Bot Access Token (Recommended for testing)

1. **Create a Webex Bot:**
   - Go to https://developer.webex.com/my-apps
   - Click "Create a New App" → "Create a Bot"
   - Fill in bot name, username, icon, description
   - Click "Add Bot"
   - **Copy the Bot Access Token** (you only see this once!)

2. **Bot Token Characteristics:**
   - Does NOT expire (unless you regenerate it)
   - Has limited permissions (cannot read messages sent to other users)
   - Can join spaces/meetings the bot is invited to
   - Format: Long-lived bearer token

### Option 2: Guest Issuer Token (JWT)

1. **Create a Guest Issuer Application:**
   - Go to https://developer.webex.com/my-apps
   - Click "Create a New App" → "Create a Guest Issuer"
   - Fill in application name
   - Click "Add Guest Issuer"
   - Copy the **Guest Issuer ID** and **Guest Issuer Secret**

2. **Generate Guest Token:**
   - You need to generate a JWT token server-side
   - The token is time-limited (typically 90 days max)
   - Requires implementing JWT signing with the secret
   - See: https://developer.webex.com/docs/guest-issuer

### Option 3: OAuth Access Token (User Token)

1. **Create an Integration:**
   - Go to https://developer.webex.com/my-apps
   - Click "Create a New App" → "Create an Integration"
   - Set Redirect URI (e.g., `http://localhost:3000/auth`)
   - Select required scopes: `spark:all` or `meeting:*` scopes
   - Save and copy Client ID and Client Secret

2. **Obtain Access Token:**
   - Implement OAuth 2.0 Authorization Code flow
   - User logs in via Webex
   - Exchange authorization code for access token
   - Token expires (default: 14 days, refresh tokens available)

## 🚀 Installation & Running

### Install Dependencies

```bash
cd ~/repos/vexa/poc/webex-sdk-test
npm install
```

### Run the Test

```bash
# With access token as argument
node test-join.js "https://meet123.webex.com/meet/j.php?MTID=xxx" "YOUR_ACCESS_TOKEN"

# Or with environment variable
export WEBEX_ACCESS_TOKEN="YOUR_ACCESS_TOKEN"
node test-join.js "https://meet123.webex.com/meet/j.php?MTID=xxx"
```

### What You Need:
1. **Meeting URL** - A valid Webex meeting link (SIP URL, PMR link, or meeting join URL)
2. **Access Token** - Bot token, Guest token, or OAuth token (see above)

## 📊 Test Results

### ❌ CRITICAL FINDING: SDK Does NOT Load in Node.js

The Webex SDK **fails immediately** when loaded in Node.js with the following error:

```
ReferenceError: window is not defined
    at Object.<anonymous> (/node_modules/@webex/internal-media-core/dist/cjs/index.js:4702:29658)
```

**What this means:**
- The SDK's `@webex/internal-media-core` module requires the `window` object
- This object only exists in browser environments, not Node.js
- The SDK **cannot even initialize** in a pure Node.js environment
- Testing meeting join/audio access is impossible without a browser runtime

### ✅ What MIGHT Work in Node.js (untested):
- Basic Webex REST API calls (messages, spaces) using HTTP client
- Webhooks/bot messaging (separate from the SDK)
- Authentication helpers (if they don't require browser globals)

### ❌ What Definitively Does NOT Work:
- **SDK Loading**: Fails immediately with "window is not defined"
- **Everything else**: Cannot test further without browser environment

### 🔍 Key Findings:

1. **Browser-Only Architecture**:
   - The SDK explicitly requires browser APIs: `navigator`, `window`, `MediaStream`, `RTCPeerConnection`
   - The `mediaHelpers` module uses `navigator.mediaDevices.getUserMedia()`
   - WebRTC peer connections require browser runtime

2. **Documentation Confirms Browser Requirement**:
   - SDK docs consistently reference HTML pages and browser consumption
   - All examples use `<script>` tags or browser module loading
   - No official Node.js examples for meeting media access

3. **What the SDK CAN Do in Node.js**:
   - Messaging (send/receive Webex messages)
   - Spaces management
   - People/room listings
   - Webhooks
   - Non-media meeting management (create, list, get details)

4. **What the SDK CANNOT Do in Node.js**:
   - Join meetings with audio/video
   - Access real-time media streams
   - Participate in calls with media

## 🎯 Conclusion: Is the SDK Approach Viable?

**For Pure Node.js use case: ❌ COMPLETELY NON-VIABLE**

The Webex Browser SDK **cannot even load** in Node.js. It fails immediately when trying to import:

```javascript
const Webex = require('webex').default;  // ❌ ReferenceError: window is not defined
```

The SDK is hardcoded to require browser globals (`window`, `navigator`, `MediaStream`, etc.) and cannot be shimmed or polyfilled effectively for server-side use.

**This is a hard blocker for any pure Node.js approach.**

However, meeting automation with Webex is still possible through alternative approaches!

## 🔄 Alternative Approaches

### Option A: Browser-Based Headless Automation (Hybrid)
**Viability: ⚠️ Possible but fragile**

- Use Puppeteer/Playwright to run the SDK in a real browser context
- Load the SDK via CDN in a minimal HTML page
- Control the browser page via Node.js automation
- Extract audio via browser's MediaStream Recording API
- **Pros**: Gets real audio streams, uses official SDK
- **Cons**: Requires display/Xvfb, higher resource usage, more brittle

### Option B: Webex Meetings XML API (Deprecated)
**Viability: ❌ NOT RECOMMENDED**

- Cisco deprecated the XML API in favor of REST API
- REST API does not support real-time media access
- Only supports meeting management, not participation

### Option C: Webex Guest SDK (Mobile/Embedded)
**Viability: ❓ RESEARCH NEEDED**

- Webex has embedded SDKs for iOS/Android
- May have different architecture than browser SDK
- Unlikely to work in pure Node.js

### Option D: Official Webex Bot Framework
**Viability: ⚠️ LIMITED**

- Webex bots can receive webhooks for messages
- **Cannot join meetings as participants**
- No access to real-time media
- Only for messaging/commands

### Option E: SIP/WebRTC Gateway Approach
**Viability: ✅ MOST VIABLE FOR PRODUCTION**

- Use a SIP client library (like `sip.js` or `drachtio`)
- Webex supports SIP dial-in to meetings
- Connect as a SIP client, receive RTP audio streams
- **Pros**: Standard protocol, designed for automation, stable
- **Cons**: More complex setup, requires SIP credentials, different auth flow

### Option F: Minimal HTML Page + SDK (No DOM Scraping)
**Viability: ⚠️ POSSIBLE**

Instead of using Playwright to scrape the Webex web app:
1. Create a minimal HTML page that loads the SDK from CDN
2. Use the SDK's official API to join and access MediaStreams
3. Use `<audio>` elements or MediaRecorder to capture streams
4. Control via Puppeteer/Playwright, but interact with SDK properly
5. **Pros**: Uses official SDK, cleaner than DOM scraping
6. **Cons**: Still requires browser/headless runtime

**Implementation sketch:**
```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://unpkg.com/webex@^3/umd/webex.min.js"></script>
</head>
<body>
  <script>
    const webex = window.Webex.init({ credentials: { access_token: ACCESS_TOKEN } });
    
    webex.once('ready', async () => {
      const meeting = await webex.meetings.create(MEETING_URL);
      
      // Create media streams
      const mic = await webex.meetings.mediaHelpers.createMicrophoneStream({ audio: true });
      
      // Join with media
      await meeting.joinWithMedia({
        mediaOptions: {
          localStreams: { microphone: mic },
          audioEnabled: true,
          videoEnabled: false
        }
      });
      
      // Listen for remote audio
      meeting.on('media:ready', (media) => {
        const remoteAudio = media.audio;
        // Set up MediaRecorder or pipe to <audio> element
        // Can use MediaRecorder API to capture to file
        const recorder = new MediaRecorder(remoteAudio);
        recorder.ondataavailable = (e) => {
          // Send chunks to Node.js parent process via CDP/IPC
        };
        recorder.start();
      });
    });
  </script>
</body>
</html>
```

This approach:
- ✅ Uses official SDK (more stable than DOM scraping)
- ✅ Gets real MediaStream objects
- ✅ Can record/process audio properly
- ❌ Still requires headless browser runtime
- ✅ Easier to maintain than reverse-engineering Webex web app

## 📚 References

- **Webex JS SDK GitHub**: https://github.com/webex/webex-js-sdk
- **Webex Browser SDK Docs**: https://developer.webex.com/docs/sdks/browser
- **Join Meeting Docs**: https://developer.webex.com/docs/sdks/webex-meetings-sdk-web-join-a-meeting
- **Getting Started**: https://developer.webex.com/docs/sdks/node
- **Developer Portal**: https://developer.webex.com/my-apps

## 🎬 Next Steps

Based on these findings, recommended next steps:

1. **If headless browser is acceptable**:
   - Build POC using minimal HTML + SDK + Puppeteer
   - Test audio capture via MediaRecorder
   - Compare stability vs Playwright DOM scraping

2. **If pure Node.js is required**:
   - Research SIP/WebRTC gateway approach
   - Investigate Webex SIP dial-in capabilities
   - Explore alternative meeting platforms with better Node.js SDK support

3. **For production**:
   - Consider if meeting audio capture is truly needed
   - Explore Webex's official bot/webhook integrations for messaging use cases
   - Investigate Webex's compliance recording features (if available)

## 📝 Files in This POC

- `package.json` - Project dependencies
- `test-join.js` - Main test script (well-commented, logs each step)
- `README.md` - This file
- `.env.example` - Example environment variables (if created)

## 🔒 Security Notes

- **Never commit access tokens to Git**
- Bot tokens are long-lived - rotate if compromised
- Guest tokens should be generated server-side
- OAuth tokens should use refresh tokens for long-term use
- Consider using environment variables or secret management

---

**Created**: 2026-02-13  
**Status**: Complete - SDK confirmed browser-only for media  
**Recommendation**: Use minimal HTML + SDK + headless browser OR explore SIP gateway approach
