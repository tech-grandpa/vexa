# Webex Platform Implementation Plan (SDK-Based Hybrid Approach)

> **Branch:** `feature/webex-platform`  
> **Author:** Jarvis (AI) for tech-grandpa/vexa  
> **Date:** 2026-02-13  
> **Status:** Updated — SDK-Based Hybrid Architecture

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [File-by-File Breakdown](#file-by-file-breakdown)
4. [Webex SDK Integration Flow](#webex-sdk-integration-flow)
5. [Audio Capture Strategy](#audio-capture-strategy)
6. [Authentication & Credentials](#authentication--credentials)
7. [Bot-Manager Changes](#bot-manager-changes)
8. [Webex Messaging API Integration](#webex-messaging-api-integration)
9. [Docker & Config Changes](#docker--config-changes)
10. [Testing Strategy](#testing-strategy)
11. [Risks & Mitigations](#risks--mitigations)
12. [Implementation Phases](#implementation-phases)

---

## Executive Summary

This plan adds **Webex** as the fourth platform to Vexa's meeting bot system. **Critical architectural change:** Instead of DOM scraping via Playwright selectors (the original approach used for Google Meet), Webex implementation uses a **hybrid SDK-based architecture**:

- **Playwright** loads a minimal HTML page (`meeting.html`) that imports the Webex Browser SDK from CDN
- **Webex SDK** handles meeting initialization, join, audio MediaStream access, and leave
- **Playwright** controls the SDK via `page.evaluate()` calling exposed JavaScript functions
- **Status/events** exposed on `window.__WEBEX_STATUS` and `window.__WEBEX_LOGS` for monitoring

**Why this approach?**

✅ **No fragile CSS selectors** — SDK handles all meeting logic  
✅ **Direct audio access** — SDK provides `remoteAudio` MediaStream via `media:ready` event  
✅ **No DOM scraping** — no need to reverse-engineer Webex UI changes  
✅ **Proven in POC** — branch `poc/webex-sdk-hybrid` demonstrates this works  
✅ **Authentication required** — unlike other platforms, Webex needs credentials (Personal Access Token, Bot Token, or OAuth)

**Key insight:** No existing OSS project supports Webex meeting transcription. This makes Vexa the first open-source tool in this space.

---

## Architecture Overview

### High-Level Flow

```
bot-manager (Python/FastAPI)
  └─ starts vexa-bot container with BOT_CONFIG (including access_token)
       └─ index.ts dispatches to platform handler
            └─ handleWebex() creates PlatformStrategies
                 └─ runMeetingFlow() orchestrates lifecycle:
                      join → waitForAdmission → prepare → startRecording → leave
```

### Webex-Specific Architecture (Hybrid SDK)

```
┌──────────────────────────────────────────────────────────┐
│ Node.js (Playwright)                                     │
│                                                          │
│  handleWebex()                                           │
│    ↓                                                     │
│  page.goto("file:///.../meeting.html")                  │
│    ↓                                                     │
│  page.evaluate(inject __WEBEX_CONFIG)                   │
│    ↓                                                     │
│  page.evaluate(() => window.initWebex())                │
│    ↓                                                     │
│  monitor window.__WEBEX_STATUS                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────┐
│ Browser Context (Chromium)                               │
│                                                          │
│  meeting.html                                            │
│    ↓                                                     │
│  <script src="https://unpkg.com/webex@^3/...">          │
│    ↓                                                     │
│  window.Webex.init({ credentials: { access_token } })   │
│    ↓                                                     │
│  webex.meetings.register()                              │
│    ↓                                                     │
│  webex.meetings.create(meetingUrl)                      │
│    ↓                                                     │
│  meeting.join({ receiveAudio: true, ... })              │
│    ↓                                                     │
│  meeting.on('media:ready', (media) => {                 │
│    if (media.type === 'remoteAudio') {                  │
│      window.__WEBEX_AUDIO_STREAM = media.stream         │
│    }                                                     │
│  })                                                      │
│    ↓                                                     │
│  AudioContext → ScriptProcessorNode                     │
│    ↓                                                     │
│  WebSocket → WhisperLive                                │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Key differences from Google Meet:**

| Aspect | Google Meet (DOM Scraping) | Webex (SDK Hybrid) |
|--------|----------------------------|-------------------|
| **Join** | CSS selectors → click buttons | `meeting.join()` API call |
| **Lobby** | Poll DOM for lobby indicators | Monitor `meeting.on('meeting:stateChange')` |
| **Audio** | Find `<audio>` elements, intercept WebRTC | SDK provides `remoteAudio` MediaStream directly |
| **Leave** | Click leave button via selector | `meeting.leave()` API call |
| **Removal** | Poll DOM for removal message | `meeting.on('meeting:removed')` event |
| **Credentials** | None (guest join) | **Required** (access token) |

---

## File-by-File Breakdown

### New Files in `services/vexa-bot/core/src/platforms/webex/`

#### `meeting.html` — **NEW: SDK Host Page**

Minimal HTML page that loads the Webex Browser SDK from CDN and exposes control functions to Playwright.

**Key sections:**

```html
<!DOCTYPE html>
<html>
<head>
  <title>Webex SDK Host</title>
</head>
<body>
  <div id="status">Initializing...</div>
  
  <!-- Load Webex SDK from CDN -->
  <script crossorigin src="https://unpkg.com/webex@^3/umd/webex.min.js"></script>
  
  <script>
    // Global state for Playwright
    window.__WEBEX_STATUS = {
      initialized: false,
      registered: false,
      meetingCreated: false,
      joined: false,
      audioReady: false,
      error: null,
      meetingState: null
    };
    
    window.__WEBEX_LOGS = [];
    window.__WEBEX_AUDIO_STREAM = null;
    window.__WEBEX_INSTANCE = null;
    window.__WEBEX_MEETING = null;
    
    function log(message, data) { /* logging helper */ }
    
    // Exposed to Playwright
    window.initWebex = async function() {
      // 1. Init SDK with credentials
      // 2. Register with Webex
      // 3. Create meeting
      // 4. Bind event listeners (media:ready, meeting:stateChange, etc.)
      // 5. Join meeting
    };
    
    window.leaveMeeting = async function() {
      // Call meeting.leave()
    };
    
    window.getAudioStream = function() {
      return window.__WEBEX_AUDIO_STREAM;
    };
    
    window.getMeetingStatus = function() {
      return window.__WEBEX_STATUS;
    };
  </script>
</body>
</html>
```

**Responsibilities:**
- Load Webex SDK from CDN (versioned via `webex@^3`)
- Initialize SDK with access token (injected by Playwright)
- Create and join meeting via SDK API
- Expose `remoteAudio` MediaStream on `media:ready` event
- Provide status/logging for Playwright to monitor

**Reference:** `poc/webex-sdk-hybrid/meeting.html`

#### `join.ts` — Meeting Join (SDK-Based)

**OLD approach (removed):** Navigate to `web.webex.com`, find selectors, click buttons  
**NEW approach:** Load `meeting.html`, inject config, call SDK functions

```typescript
export async function joinWebexMeeting(
  page: Page,
  meetingUrl: string,
  botName: string,
  botConfig: BotConfig
): Promise<void>;
```

**Flow:**

1. **Load meeting.html** from local file system:
   ```typescript
   const htmlPath = path.join(__dirname, 'meeting.html');
   await page.goto(`file://${htmlPath}`);
   ```

2. **Inject configuration** via `page.evaluate()`:
   ```typescript
   await page.evaluate(({ meetingUrl, accessToken, botName }) => {
     window.__WEBEX_CONFIG = {
       meetingUrl,
       access_token: accessToken,
       displayName: botName
     };
   }, {
     meetingUrl,
     accessToken: botConfig.data.access_token,
     botName
   });
   ```

3. **Initialize and join** via SDK:
   ```typescript
   await page.evaluate(() => window.initWebex());
   ```

4. **Monitor status** until `joined`:
   ```typescript
   await page.waitForFunction(() => {
     const status = window.__WEBEX_STATUS;
     return status.joined || status.error;
   }, { timeout: 60000 });
   ```

5. **Handle errors:**
   ```typescript
   const status = await page.evaluate(() => window.__WEBEX_STATUS);
   if (status.error) {
     throw new Error(`Webex join failed: ${status.error}`);
   }
   ```

**No selectors needed!** The SDK handles all UI interactions.

**Reference:** `poc/webex-sdk-hybrid/test-hybrid.js` (lines 34-66)

#### `admission.ts` — Lobby & Admission (SDK Events)

**OLD approach (removed):** Poll DOM for lobby indicators  
**NEW approach:** Monitor SDK's `meeting:stateChange` events

```typescript
export async function waitForWebexAdmission(
  page: Page,
  timeoutMs: number,
  botConfig: BotConfig
): Promise<AdmissionResult>;

export async function checkForWebexAdmissionSilent(
  page: Page
): Promise<boolean>;
```

**SDK meeting states:**
- `IDLE` → initial
- `LOBBY` → waiting for host to admit (if enabled)
- `JOINED` → admitted and in meeting
- `LEFT` → left the meeting
- `REJECTED` → host denied entry

**Flow:**

```typescript
// Monitor meeting state transitions
await page.waitForFunction(() => {
  const status = window.__WEBEX_STATUS;
  return status.meetingState === 'JOINED' || 
         status.meetingState === 'REJECTED' ||
         status.error;
}, { timeout: timeoutMs });

const finalStatus = await page.evaluate(() => window.__WEBEX_STATUS);

if (finalStatus.meetingState === 'REJECTED') {
  return { admitted: false, rejected: true };
}

if (finalStatus.error) {
  throw new Error(finalStatus.error);
}

return { admitted: true, rejected: false };
```

**No DOM polling!** The SDK emits state change events that we capture in `meeting.html`.

#### `recording.ts` — Audio Capture & WhisperLive Integration

**OLD approach (removed):** Intercept RTCPeerConnection, find `<audio>` DOM elements  
**NEW approach:** SDK provides `remoteAudio` MediaStream directly via `media:ready` event

```typescript
export async function startWebexRecording(
  page: Page,
  botConfig: BotConfig
): Promise<void>;
```

**Audio pipeline:**

```
Webex SDK media:ready event
  → window.__WEBEX_AUDIO_STREAM (MediaStream)
  → AudioContext.createMediaStreamSource()
  → ScriptProcessorNode (downsample to 16kHz mono)
  → WebSocket → WhisperLive server
```

**Implementation pattern (same as Google Meet, but simpler):**

1. **Initialize WhisperLive on Node.js side:**
   ```typescript
   const whisperLive = new WhisperLiveService(botConfig);
   await whisperLive.connect();
   ```

2. **Inject browser-side audio capture code:**
   ```typescript
   await page.evaluate((config) => {
     // Wait for __WEBEX_AUDIO_STREAM to be available
     const checkAudioReady = setInterval(() => {
       if (window.__WEBEX_AUDIO_STREAM) {
         clearInterval(checkAudioReady);
         
         // Create AudioContext
         const audioContext = new AudioContext({ sampleRate: 16000 });
         const source = audioContext.createMediaStreamSource(
           window.__WEBEX_AUDIO_STREAM
         );
         
         // Create processor (16kHz mono PCM)
         const processor = audioContext.createScriptProcessor(4096, 1, 1);
         
         processor.onaudioprocess = (e) => {
           const audioData = e.inputBuffer.getChannelData(0);
           
           // Convert Float32Array to Int16Array
           const int16Audio = new Int16Array(audioData.length);
           for (let i = 0; i < audioData.length; i++) {
             int16Audio[i] = Math.max(-1, Math.min(1, audioData[i])) * 0x7FFF;
           }
           
           // Send to WhisperLive via WebSocket
           if (window.__WHISPER_WS?.readyState === WebSocket.OPEN) {
             window.__WHISPER_WS.send(int16Audio.buffer);
           }
         };
         
         source.connect(processor);
         processor.connect(audioContext.destination);
       }
     }, 100);
   }, botConfig);
   ```

3. **Speaker detection (if SDK supports it):**
   
   The Webex SDK provides `meeting.members` collection. Each member has properties like:
   - `isActiveSpeaker` (boolean, updated when speaker changes)
   - `isSpeaking` (boolean, based on audio level)
   - `audioMuted` (boolean)
   
   **Implementation:**
   
   ```typescript
   // In meeting.html, after meeting.join():
   meeting.on('meeting:activeSpeakerChanged', (payload) => {
     const { activeSpeaker } = payload;
     window.__WEBEX_LOGS.push({
       type: 'SPEAKER_CHANGE',
       timestamp: Date.now(),
       speakerId: activeSpeaker.id,
       speakerName: activeSpeaker.name
     });
     
     // Send to WhisperLive for diarization
     if (window.__SPEAKER_DETECTION_ENABLED) {
       // Send SPEAKER_START event
     }
   });
   
   meeting.on('members:update', (delta) => {
     // Track member join/leave, mute/unmute
   });
   ```
   
   **Fallback:** If SDK doesn't provide `activeSpeakerChanged` event, poll `meeting.members` for `isActiveSpeaker` changes every 500ms.

4. **Alone-in-meeting timeout:**
   
   ```typescript
   // Check meeting.members.length
   const participantCount = await page.evaluate(() => {
     const meeting = window.__WEBEX_MEETING;
     return meeting?.members?.membersCollection?.length || 0;
   });
   
   if (participantCount <= 1) {
     // Start alone timeout counter
   }
   ```

**No RTCPeerConnection interception!** No DOM element scanning! SDK gives us everything.

**Reference:** `poc/webex-sdk-hybrid/test-hybrid.js` (lines 125-167)

#### `leave.ts` — Graceful Leave (SDK Call)

**OLD approach (removed):** Find leave button selector, click  
**NEW approach:** Call `meeting.leave()` via SDK

```typescript
export async function prepareForWebexRecording(
  page: Page,
  botConfig: BotConfig
): Promise<void>;

export async function leaveWebex(
  page: Page | null,
  botConfig?: BotConfig,
  reason?: LeaveReason
): Promise<boolean>;
```

**Flow:**

```typescript
try {
  await page.evaluate(() => window.leaveMeeting());
  return true;
} catch (err) {
  log.error('Failed to leave Webex meeting', err);
  return false;
}
```

**Simple!** Just one line in the browser context: `await meeting.leave()`

#### `removal.ts` — Removal/End Detection (SDK Events)

**OLD approach (removed):** Poll DOM for "You've been removed" text  
**NEW approach:** Listen to SDK events

```typescript
export async function startWebexRemovalMonitor(
  page: Page,
  onRemoval?: () => void | Promise<void>
): () => void;
```

**SDK events to monitor:**

```typescript
// In meeting.html:
meeting.on('meeting:removed', (reason) => {
  log('Bot was removed from meeting', reason);
  window.__WEBEX_STATUS.removed = true;
  window.__WEBEX_STATUS.removalReason = reason.type;
});

meeting.on('meeting:ended', () => {
  log('Meeting ended by host');
  window.__WEBEX_STATUS.ended = true;
});
```

**Monitoring from Playwright:**

```typescript
const stopMonitoring = async () => {
  while (true) {
    await page.waitForTimeout(1000);
    
    const status = await page.evaluate(() => window.__WEBEX_STATUS);
    
    if (status.removed || status.ended) {
      if (onRemoval) {
        await onRemoval();
      }
      break;
    }
  }
};

// Return cleanup function
return () => { /* stop monitoring loop */ };
```

#### `index.ts` — Platform Handler Entry Point

Wires up SDK-based strategies and calls `runMeetingFlow()`.

```typescript
import { PlatformStrategies, runMeetingFlow } from "../shared/meetingFlow";
import { joinWebexMeeting } from "./join";
import { waitForWebexAdmission, checkForWebexAdmissionSilent } from "./admission";
import { prepareForWebexRecording } from "./leave";
import { startWebexRecording } from "./recording";
import { startWebexRemovalMonitor } from "./removal";
import { leaveWebex } from "./leave";

export async function handleWebex(
  botConfig: BotConfig,
  page: Page,
  gracefulLeaveFunction: (page: Page | null, exitCode: number, reason: string, errorDetails?: any) => Promise<void>
): Promise<void> {
  
  // Validate credentials
  if (!botConfig.data?.access_token) {
    throw new Error('Webex platform requires access_token in botConfig.data');
  }
  
  const strategies: PlatformStrategies = {
    join: joinWebexMeeting,
    waitForAdmission: waitForWebexAdmission,
    checkAdmissionSilent: checkForWebexAdmissionSilent,
    prepare: prepareForWebexRecording,
    startRecording: startWebexRecording,
    startRemovalMonitor: startWebexRemovalMonitor,
    leave: leaveWebex
  };

  await runMeetingFlow(page, botConfig, strategies, gracefulLeaveFunction);
}

export { leaveWebex };
```

**Pattern:** Identical to `platforms/googlemeet/index.ts`, just SDK-based strategies instead of DOM-based.

#### `selectors.ts` — **REMOVED ENTIRELY**

**No CSS selectors needed!** The SDK handles all UI interactions. This file is not created.

---

## Webex SDK Integration Flow

### 1. SDK Initialization

```javascript
const webex = window.Webex.init({
  credentials: {
    access_token: '<user_or_bot_token>'
  }
});
```

### 2. Registration

```javascript
await webex.meetings.register();
```

This connects the SDK to Webex infrastructure and prepares for meeting operations.

### 3. Meeting Creation

```javascript
const meeting = await webex.meetings.create(destination);
```

`destination` can be:
- Full meeting URL: `https://example.webex.com/meet/john`
- Email address: `john.doe@example.com`
- SIP URI: `meeting@example.webex.com`
- Person ID or Room ID (base64-encoded Webex identifiers)

### 4. Event Binding

```javascript
meeting.on('media:ready', (media) => {
  if (media.type === 'remoteAudio') {
    window.__WEBEX_AUDIO_STREAM = media.stream;
  }
});

meeting.on('meeting:stateChange', (state) => {
  window.__WEBEX_STATUS.meetingState = state.current;
});

meeting.on('meeting:removed', (reason) => {
  window.__WEBEX_STATUS.removed = true;
});

meeting.on('members:update', (delta) => {
  // Track participant changes
});
```

### 5. Join Meeting

```javascript
await meeting.join({
  mediaOptions: {
    receiveAudio: true,   // Capture audio from others
    receiveVideo: false,  // No video needed
    sendAudio: false,     // Bot doesn't speak
    sendVideo: false      // Bot doesn't show video
  }
});
```

### 6. Audio Stream Access

```javascript
// Available after 'media:ready' event fires
const audioStream = window.__WEBEX_AUDIO_STREAM;
const audioContext = new AudioContext({ sampleRate: 16000 });
const source = audioContext.createMediaStreamSource(audioStream);
// ... connect to WhisperLive
```

### 7. Leave Meeting

```javascript
await meeting.leave();
```

---

## Audio Capture Strategy

### Primary: SDK-Provided MediaStream

The Webex SDK provides `remoteAudio` directly via the `media:ready` event. **No interception needed!**

**Flow:**

```
Webex SDK
  ↓ (media:ready event)
MediaStream (remoteAudio)
  ↓
AudioContext.createMediaStreamSource()
  ↓
ScriptProcessorNode (4096 buffer, 16kHz mono)
  ↓
Convert Float32Array → Int16Array
  ↓
WebSocket.send() → WhisperLive
```

**Code (browser-side):**

```javascript
meeting.on('media:ready', (media) => {
  if (media.type === 'remoteAudio') {
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(media.stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    
    processor.onaudioprocess = (e) => {
      const float32Audio = e.inputBuffer.getChannelData(0);
      
      // Convert to Int16
      const int16Audio = new Int16Array(float32Audio.length);
      for (let i = 0; i < float32Audio.length; i++) {
        int16Audio[i] = Math.max(-1, Math.min(1, float32Audio[i])) * 0x7FFF;
      }
      
      // Send to WhisperLive
      if (window.__WHISPER_WS?.readyState === WebSocket.OPEN) {
        window.__WHISPER_WS.send(int16Audio.buffer);
      }
    };
    
    source.connect(processor);
    processor.connect(audioContext.destination);
  }
});
```

### Speaker Detection

**SDK provides:**
- `meeting.on('meeting:activeSpeakerChanged', callback)` — fires when active speaker changes
- `meeting.members.membersCollection` — array of participants
- Each member has:
  - `id`, `name`, `isActiveSpeaker`, `isSpeaking`, `audioMuted`, etc.

**Implementation:**

```javascript
meeting.on('meeting:activeSpeakerChanged', (payload) => {
  const speaker = payload.activeSpeaker;
  
  // Send SPEAKER_START event to WhisperLive
  sendSpeakerEvent({
    type: 'SPEAKER_START',
    speakerId: speaker.id,
    speakerName: speaker.name,
    timestamp: Date.now()
  });
});
```

**Fallback:** If `activeSpeakerChanged` event is unreliable, poll `meeting.members` every 500ms for `isActiveSpeaker` changes.

### No RTCPeerConnection Interception Needed!

Unlike the original plan (and Google Meet implementation), **we don't need to patch `RTCPeerConnection.prototype`** because the SDK gives us direct MediaStream access.

---

## Authentication & Credentials

**CRITICAL DIFFERENCE:** Webex requires authentication (unlike Google Meet/Zoom which support anonymous guest join).

### Authentication Methods

#### 1. Personal Access Token (Development/Testing)

**Use case:** Quick testing, POC, personal use  
**Validity:** 12 hours  
**How to get:**
1. Go to https://developer.webex.com
2. Sign in with your Webex account
3. Navigate to **Getting Started** → https://developer.webex.com/docs/api/getting-started
4. Copy the auto-generated **Personal Access Token**

**Scopes:** All personal scopes (full meeting access)

**Limitations:**
- Expires after 12 hours
- Cannot be used in production
- Tied to a specific user account

**Configuration:**
```typescript
botConfig.data.access_token = '<personal_access_token>';
```

#### 2. Bot Token (Production)

**Use case:** Production deployment, automated bots  
**Validity:** No expiration (can be regenerated)  
**How to get:**
1. Go to https://developer.webex.com
2. Sign in and click **Start Building Apps**
3. Choose **Create a Bot**
4. Fill in bot name, username, icon
5. Copy the **Bot Access Token** (shown only once!)

**Scopes:** Limited to bot scopes (meeting participation, message sending)

**Limitations:**
- Must be added to spaces/meetings to participate
- Cannot access user-specific resources

**Configuration:**
```typescript
botConfig.data.access_token = '<bot_access_token>';
```

#### 3. OAuth Integration (Production, User-Delegated)

**Use case:** Enterprise deployments, user-authorized bots  
**Validity:** Access token (short-lived), refresh token (long-lived)  
**How to get:**
1. Create an Integration at https://developer.webex.com
2. Configure OAuth scopes (e.g., `meeting:schedules_read`, `spark:all`)
3. Implement OAuth flow (authorize → exchange code for tokens)
4. Refresh access token when expired

**Scopes:** Customizable per integration

**Limitations:**
- Requires OAuth flow implementation
- Token refresh logic needed

**Configuration:**
```typescript
botConfig.data.access_token = '<oauth_access_token>';
// Store refresh_token securely for token renewal
```

#### 4. Guest Issuer (Guest Access)

**Use case:** Allow non-Webex users to join meetings  
**Validity:** JWT tokens with custom expiration  
**How to get:**
1. Create an Integration with Guest Issuer enabled
2. Use Guest Issuer API to generate JWT tokens for guest users
3. Documentation: https://developer.webex.com/docs/guest-issuer

**Limitations:**
- Requires server-side JWT generation
- Guest users have limited permissions

### Bot-Manager Integration

**New field in `MeetingCreate` request:**

```python
# In bot-manager API
class MeetingCreate(BaseModel):
    platform: Platform
    native_meeting_id: str
    bot_name: str
    # ... existing fields ...
    
    # NEW for Webex:
    webex_access_token: Optional[str] = None  # Required if platform == WEBEX
```

**Validation:**

```python
if meeting.platform == Platform.WEBEX and not meeting.webex_access_token:
    raise HTTPException(
        status_code=400,
        detail="webex_access_token is required for Webex meetings"
    )
```

**Passed to bot container:**

```python
bot_config = {
    "platform": "webex",
    "native_meeting_id": meeting_url,
    "data": {
        "access_token": meeting.webex_access_token  # NEW
    }
    # ... rest of config
}
```

### Security Considerations

- **Never log access tokens** — mask in logs as `<token>***`
- **Store bot tokens securely** — use environment variables or secret management
- **Implement token rotation** for OAuth integrations
- **Validate token scopes** before joining meetings

---

## Bot-Manager Changes

### 1. Platform Enum (`libs/shared-models/shared_models/schemas.py`)

```python
class Platform(str, Enum):
    GOOGLE_MEET = "google_meet"
    ZOOM = "zoom"
    TEAMS = "teams"
    WEBEX = "webex"          # ADD
```

Add to `bot_name` mapping:
```python
mapping = {
    ...
    Platform.WEBEX: "webex",
}
```

Add to `construct_meeting_url`:
```python
elif platform == Platform.WEBEX:
    # Accept full Webex meeting URLs
    # Validate it's a webex.com domain
    if re.match(r'^https?://[\w.-]*webex\.com/', native_id):
        return native_id
    # Or accept email addresses (for direct calls)
    if re.fullmatch(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$', native_id):
        return native_id  # SDK accepts email addresses directly
    # Or accept SIP URIs
    if '@' in native_id and 'webex.com' in native_id:
        return native_id
    return None
```

### 2. BotConfig Type (`services/vexa-bot/core/src/types.ts`)

```typescript
export type BotConfig = {
  platform: "google_meet" | "zoom" | "teams" | "webex",  // ADD "webex"
  native_meeting_id: string,
  data: {
    access_token?: string,  // NEW: Required for Webex
    // ... existing fields
  },
  // ... rest unchanged
}
```

### 3. Bot Entry Point (`services/vexa-bot/core/src/index.ts`)

Add Webex handler import and dispatch:

```typescript
import { handleWebex, leaveWebex } from "./platforms/webex";

// In runBot():
} else if (botConfig.platform === "webex") {
  await handleWebex(botConfig, page, performGracefulLeave);
}

// In performGracefulLeave():
} else if (currentPlatform === "webex") {
  platformLeaveSuccess = await leaveWebex(page);
}
```

Browser launch: Webex SDK works with Chrome (Chromium), no special browser config needed.

### 4. Orchestrator / Container Config

No changes needed to the Docker orchestrator — it already passes `platform` generically through `BOT_CONFIG`. The container image is the same `vexa-bot:dev` for all platforms.

---

## Webex Messaging API Integration

### Optional Feature: Deliver Transcripts to Webex Spaces

After a meeting ends, the transcript can be posted to a Webex space using the Webex REST API.

#### Architecture

```
meeting ends → bot-manager post-meeting tasks → Webex Messaging API → Webex space
```

#### Implementation

**New file: `services/bot-manager/app/tasks/bot_exit_tasks/send_webex_transcript.py`**

```python
import httpx

WEBEX_API_BASE = "https://webexapis.com/v1"

async def send_transcript_to_webex(
    meeting_id: int,
    webex_access_token: str,  # Bot or user OAuth token
    room_id: str,             # Webex space/room to post to
    transcript_text: str
):
    """Post meeting transcript to a Webex space."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{WEBEX_API_BASE}/messages",
            headers={"Authorization": f"Bearer {webex_access_token}"},
            json={
                "roomId": room_id,
                "markdown": f"## Meeting Transcript\n\n{transcript_text}"
            }
        )
        response.raise_for_status()
```

#### Requirements
- A Webex Bot or Integration registered at [developer.webex.com](https://developer.webex.com)
- Bot must be added to the target space
- OAuth scopes: `spark:messages_write`

#### Configuration
```env
WEBEX_BOT_TOKEN=<webex_bot_access_token>
WEBEX_TRANSCRIPT_ROOM_ID=<default_room_id>  # Optional default
```

**This feature is Phase 2** — initial implementation focuses on core meeting join + transcription.

---

## Docker & Config Changes

### Environment Variables

Add to `env-example.*` files:

```env
# Webex Platform (optional - only needed for Webex transcript delivery)
WEBEX_BOT_TOKEN=
WEBEX_TRANSCRIPT_ROOM_ID=
```

### Docker Compose

No changes needed to `docker-compose.yml` — the vexa-bot service is already generic. Bot containers are spawned dynamically by bot-manager with platform-specific `BOT_CONFIG`.

### Playwright Browser

Webex SDK works with Chromium. The existing default browser launch path is suitable. Key browser args already present:

```typescript
// Already in browserArgs constant:
'--use-fake-ui-for-media-stream',  // Auto-allow mic/camera
'--use-fake-device-for-media-stream',
'--disable-web-security',
'--autoplay-policy=no-user-gesture-required',
// etc.
```

No additional browser configuration needed.

---

## Testing Strategy

### Phase 1: SDK Integration & Join Flow (No Selector Research!)

1. **Create `meeting.html`** based on POC template
2. **Implement `join.ts`** to load HTML and call `initWebex()`
3. **Test join flow** with Personal Access Token
4. **Validate status monitoring** (`window.__WEBEX_STATUS`)
5. **Screenshot checkpoints** at each step

### Phase 2: Audio Capture & Transcription

1. **Verify `media:ready` event** fires with `remoteAudio` stream
2. **Implement audio capture** (AudioContext → ScriptProcessorNode)
3. **Test WhisperLive connection** and audio pipeline
4. **Verify transcription** with multiple speakers
5. **Implement speaker detection** (`activeSpeakerChanged` event or polling)

### Phase 3: Admission & Removal

1. **Test lobby flow** (if meeting has lobby enabled)
2. **Test direct join** (no lobby)
3. **Test removal detection** (`meeting:removed` event)
4. **Test meeting end** (`meeting:ended` event)

### Phase 4: Bot-Manager Integration

1. **Add Webex to platform enum**
2. **Add `access_token` to API schema**
3. **Wire up `handleWebex` in `index.ts`**
4. **Test full container lifecycle**
5. **Test with bot token (not just personal token)**

### Phase 5: End-to-End

- Full flow: API request → bot-manager → container → join Webex → transcribe → leave → transcript stored
- Test with multiple participants switching speakers
- Test with OAuth token (if implementing OAuth)
- Test alone-timeout and admission-timeout

### Test Infrastructure

```
testing/
  webex/
    test_sdk_init.ts        # SDK initialization and join
    test_audio_capture.ts   # Audio pipeline verification
    test_events.ts          # Event handling (state changes, removal)
    test_e2e.ts             # Full end-to-end test
```

---

## Risks & Mitigations

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **SDK version changes/deprecation** | Breaking changes in new SDK releases | Pin SDK version in `meeting.html` (`webex@^3`). Monitor release notes. Add version validation. |
| **Authentication token management** | Expired tokens → join failures | Implement token refresh logic for OAuth. Document Personal Token 12h expiration. Validate token before join. |
| **SDK CDN availability** | CDN outage → bot can't join | Consider hosting SDK locally (download from npm, serve from container). Add fallback CDN. |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **SDK requires sign-in for some meetings** | Can't join restricted meetings | Document limitation. Support both bot and user OAuth tokens. |
| **Meeting password handling** | Bot can't join password-protected meetings | Accept password via `MeetingCreate.passcode` field. Pass to SDK if supported. |
| **Content Security Policy** | Script injection blocked | Already handled: Playwright `bypassCSP: true` in context creation. |
| **Different Webex editions** | Enterprise features differ from Free tier | Test across editions. Document edition-specific behavior. |

### Low Risk (Previously High, Now Mitigated)

| Risk | Impact | Mitigation |
|------|--------|------------|
| ~~Webex UI changes~~ | ~~Selectors break~~ | **REMOVED:** No selectors used! SDK is stable API. |
| ~~No audio elements in DOM~~ | ~~Can't capture audio~~ | **REMOVED:** SDK provides MediaStream directly. |
| ~~Bot detection~~ | ~~Bot blocked~~ | **REDUCED:** SDK is official Webex API, less likely to be blocked. |
| ~~Desktop app prompts~~ | ~~Join flow breaks~~ | **REMOVED:** No web UI interaction needed. |
| ~~CAPTCHA~~ | ~~Can't join~~ | **REMOVED:** SDK authenticates via token, no CAPTCHA. |

---

## Implementation Phases

### Phase 1: SDK Integration & Join Flow (3-5 days)
- [ ] Create `meeting.html` (based on POC)
- [ ] Implement `join.ts` (load HTML, inject config, call `initWebex()`)
- [ ] Implement `admission.ts` (monitor SDK state changes)
- [ ] Implement `leave.ts` (call `meeting.leave()`)
- [ ] Add `"webex"` to Platform enum and BotConfig type
- [ ] Test join flow with Personal Access Token

### Phase 2: Audio Capture & Transcription (3-5 days)
- [ ] Implement `recording.ts` (capture `remoteAudio` stream)
- [ ] Connect audio to WhisperLive WebSocket
- [ ] Test transcription pipeline
- [ ] Implement speaker detection (SDK events or polling)
- [ ] Implement `removal.ts` (monitor SDK events)

### Phase 3: Bot-Manager Integration (2-3 days)
- [ ] Add Webex URL construction to `construct_meeting_url`
- [ ] Add `webex_access_token` field to API schema
- [ ] Wire up `handleWebex` in `index.ts`
- [ ] Test full container lifecycle
- [ ] Test with bot token (register bot at developer.webex.com)

### Phase 4: Authentication & Token Management (2-3 days)
- [ ] Document authentication methods (Personal, Bot, OAuth, Guest)
- [ ] Implement token validation before join
- [ ] Add token refresh logic for OAuth (if implementing)
- [ ] Security audit (token masking in logs, secure storage)

### Phase 5: Webex Messaging API (Optional, 2-3 days)
- [ ] Implement transcript delivery to Webex spaces
- [ ] Add Webex bot token configuration
- [ ] Test message posting

### Phase 6: Hardening & Testing (3-5 days)
- [ ] Write integration tests
- [ ] Test edge cases (lobby, rejection, removal, alone timeout)
- [ ] Test across Webex editions (Free/Business)
- [ ] Document known limitations
- [ ] Update README

**Estimated total: 2-3 weeks** (down from 4-6 weeks due to no selector research needed!)

---

## Appendix: Key Differences from Google Meet

| Aspect | Google Meet | Webex (SDK Hybrid) |
|--------|-------------|-------------------|
| **Architecture** | DOM scraping via Playwright | SDK API calls |
| **Join method** | Navigate to URL, click buttons | Load HTML, call `meeting.join()` |
| **Selectors** | ~50-100 CSS/aria selectors | **None!** |
| **Audio capture** | Find `<audio>` DOM elements | SDK provides MediaStream |
| **WebRTC interception** | Patch `RTCPeerConnection.prototype` | **Not needed!** |
| **Speaker detection** | MutationObserver on DOM | SDK events (`activeSpeakerChanged`) |
| **Lobby/admission** | Poll DOM for lobby indicators | SDK state change events |
| **Leave meeting** | Click button via selector | Call `meeting.leave()` |
| **Removal detection** | Poll DOM for removal message | SDK `meeting:removed` event |
| **Credentials** | None (anonymous guest) | **Required** (access token) |
| **Fragility** | High (UI changes break selectors) | Low (SDK is stable API) |
| **Maintenance** | Ongoing selector updates | Minimal (SDK version updates) |

---

## Appendix: Reference Implementation Files

When implementing, use these existing files as templates for **structure** (not selectors):

| New Webex File | Template File (Structure Reference) | Key Changes |
|----------------|-------------------------------------|-------------|
| `platforms/webex/index.ts` | `platforms/googlemeet/index.ts` | Add token validation |
| `platforms/webex/join.ts` | `platforms/googlemeet/join.ts` | Replace DOM navigation with SDK calls |
| `platforms/webex/admission.ts` | `platforms/googlemeet/admission.ts` | Replace DOM polling with SDK events |
| `platforms/webex/recording.ts` | `platforms/googlemeet/recording.ts` | Simpler: SDK gives MediaStream directly |
| `platforms/webex/removal.ts` | `platforms/googlemeet/removal.ts` | Replace DOM polling with SDK events |
| `platforms/webex/leave.ts` | `platforms/googlemeet/leave.ts` | Replace selector click with SDK call |
| `platforms/webex/meeting.html` | `poc/webex-sdk-hybrid/meeting.html` | POC is the actual implementation base! |

**Note:** The POC branch `poc/webex-sdk-hybrid` contains the **actual working implementation** of the SDK integration. The Google Meet files are only referenced for **code structure patterns** (error handling, logging, strategy interface), NOT for selector logic.

---

**Status:** ✅ Implementation plan updated to SDK-based hybrid architecture (validated by POC)
