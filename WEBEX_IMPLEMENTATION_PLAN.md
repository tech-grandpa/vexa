# Webex Platform Implementation Plan

> **Branch:** `feature/webex-platform`  
> **Author:** Jarvis (AI) for tech-grandpa/vexa  
> **Date:** 2026-02-13  
> **Status:** Draft

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [File-by-File Breakdown](#file-by-file-breakdown)
4. [Webex Join Flow](#webex-join-flow)
5. [Audio Capture Strategy](#audio-capture-strategy)
6. [Bot-Manager Changes](#bot-manager-changes)
7. [Webex Messaging API Integration](#webex-messaging-api-integration)
8. [Docker & Config Changes](#docker--config-changes)
9. [Testing Strategy](#testing-strategy)
10. [Risks & Mitigations](#risks--mitigations)
11. [Implementation Phases](#implementation-phases)

---

## Executive Summary

This plan adds **Webex** as the fourth platform to Vexa's meeting bot system, following the established plugin architecture used by Google Meet and MS Teams. The bot will join Webex meetings via the web client (`web.webex.com`), capture audio through browser MediaStreams, and pipe it to WhisperLive for real-time transcription. Transcripts can optionally be delivered back to Webex spaces via the Webex Messaging API.

**Key insight:** No existing OSS project supports Webex meeting transcription. This makes Vexa the first open-source tool in this space.

---

## Architecture Overview

Vexa's platform plugin system follows a clean strategy pattern:

```
bot-manager (Python/FastAPI)
  └─ starts vexa-bot container with BOT_CONFIG
       └─ index.ts dispatches to platform handler
            └─ platform handler creates PlatformStrategies
                 └─ runMeetingFlow() orchestrates lifecycle:
                      join → waitForAdmission → prepare → startRecording → leave
```

Each platform implements `PlatformStrategies`:
- `join(page, botConfig)` — Navigate to meeting URL, enter name, click join
- `waitForAdmission(page, timeoutMs, botConfig)` — Wait for host to admit bot
- `checkAdmissionSilent(page)` — Verify still in meeting (no side effects)
- `prepare(page, botConfig)` — Mute mic/camera, dismiss dialogs
- `startRecording(page, botConfig)` — Capture audio, connect WhisperLive, monitor participants
- `startRemovalMonitor(page, onRemoval)` — Detect if bot is kicked
- `leave(page, botConfig, reason)` — Click leave button, clean up

The shared `runMeetingFlow()` handles all lifecycle orchestration, error handling, status callbacks, and removal monitoring. Platform code only needs to implement the UI-specific parts.

---

## File-by-File Breakdown

### New Files in `services/vexa-bot/core/src/platforms/webex/`

#### `selectors.ts`
Centralized CSS/aria selectors for `web.webex.com` UI elements.

```typescript
// Key selector groups to define:

// Join flow
export const webexNameInputSelectors: string[];      // Guest name input field
export const webexJoinButtonSelectors: string[];     // "Join meeting" / "Join" button
export const webexMicrophoneButtonSelectors: string[]; // Mute mic toggle
export const webexCameraButtonSelectors: string[];   // Camera off toggle

// Admission detection
export const webexLobbyIndicators: string[];         // "Waiting for host" / lobby screen
export const webexInMeetingIndicators: string[];     // Controls toolbar, participant panel, etc.
export const webexRejectionIndicators: string[];     // "Host denied your request" etc.

// Participant & speaker detection
export const webexParticipantSelectors: string[];    // Participant list items
export const webexParticipantNameSelectors: string[];// Name within participant element
export const webexSpeakingIndicators: string[];      // Active speaker visual cues (blue border, icon)
export const webexParticipantCountSelectors: string[]; // Participant count badge

// Removal / end detection
export const webexRemovedIndicators: string[];       // "You've been removed" / "Meeting ended"
export const webexLeaveButtonSelectors: string[];    // Leave meeting button

// People panel
export const webexPeopleButtonSelectors: string[];   // Button to open participants panel
```

**Research required:** These selectors must be reverse-engineered from `web.webex.com` by inspecting the DOM during a live Webex meeting. Webex uses React with dynamically generated class names, so **aria-labels and data attributes** should be preferred over CSS classes.

#### `join.ts`
Handles navigation to Webex meeting and joining as a guest.

```typescript
export async function joinWebexMeeting(
  page: Page, meetingUrl: string, botName: string, botConfig: BotConfig
): Promise<void>;
```

**Webex join flow specifics:**
1. Navigate to `https://web.webex.com/meet/<meeting_id>` (or full meeting link)
2. Webex may redirect to a "Join" landing page — wait for it to load
3. Select "Join from browser" (not the desktop app prompt)
4. Enter guest name in the name input field
5. Mute microphone and camera before joining
6. Click "Join meeting" button
7. Handle potential "Enter meeting password" prompt (if meeting has password)

#### `admission.ts`
Handles lobby/waiting room detection.

```typescript
export async function waitForWebexAdmission(
  page: Page, timeoutMs: number, botConfig: BotConfig
): Promise<AdmissionResult>;

export async function checkForWebexAdmissionSilent(
  page: Page
): Promise<boolean>;
```

**Webex admission specifics:**
- Webex has a lobby system similar to Teams/Meet
- Bot needs to detect transition from lobby → meeting (toolbar appears, participant list loads)
- Rejection: host can deny entry → detect rejection message
- Some meetings allow direct join (no lobby) — handle instant admission

#### `recording.ts`
Core audio capture and WhisperLive integration. This is the most complex file.

```typescript
export async function startWebexRecording(
  page: Page, botConfig: BotConfig
): Promise<void>;
```

**Pattern:** Follows Google Meet's recording.ts closely:
1. Initialize `WhisperLiveService` on Node.js side with stubborn reconnection
2. Inject browser-side code via `page.evaluate()` that:
   - Creates `BrowserAudioService` to find `<audio>`/`<video>` elements and capture MediaStreams
   - Creates `BrowserWhisperLiveService` for WebSocket communication
   - Sets up speaker detection via MutationObserver on participant elements
   - Monitors participant count for alone-timeout logic
   - Handles reconfiguration (language/task changes) via `triggerWebSocketReconfigure`

#### `removal.ts`
Detects if the bot has been removed from the meeting.

```typescript
export async function startWebexRemovalMonitor(
  page: Page, onRemoval?: () => void | Promise<void>
): () => void;
```

**Detection strategies:**
- Poll for "You've been removed" / "Meeting has ended" text
- Monitor URL changes (redirect away from meeting page)
- Watch for disappearance of in-meeting UI elements (toolbar)

#### `leave.ts`
Handles graceful departure from the meeting.

```typescript
export async function prepareForWebexRecording(
  page: Page, botConfig: BotConfig
): Promise<void>;

export async function leaveWebex(
  page: Page | null, botConfig?: BotConfig, reason?: LeaveReason
): Promise<boolean>;
```

**Leave flow:**
1. Click the "Leave meeting" button
2. Confirm leave if dialog appears
3. Return `true` if successful, `false` if button not found

#### `index.ts`
Platform handler entry point — wires up strategies and calls `runMeetingFlow()`.

```typescript
import { PlatformStrategies, runMeetingFlow } from "../shared/meetingFlow";

export async function handleWebex(
  botConfig: BotConfig,
  page: Page,
  gracefulLeaveFunction: (page: Page | null, exitCode: number, reason: string, errorDetails?: any) => Promise<void>
): Promise<void>;

export { leaveWebex };
```

This follows the exact pattern of `platforms/googlemeet/index.ts`.

---

## Webex Join Flow

### Meeting URL Formats

Webex supports several URL patterns:
```
https://meet<N>.webex.com/meet/pr/<PMR_ID>           # Personal Meeting Room
https://<site>.webex.com/meet/<host_name>             # Named PMR
https://<site>.webex.com/<site>/j.php?MTID=<id>      # Scheduled meeting
https://web.webex.com/meet/<meeting_id>               # Universal web link
```

The bot-manager `construct_meeting_url` should normalize these. For the initial implementation, accept full Webex meeting URLs as `native_meeting_id` (similar to how Teams handles full URLs).

### Browser Flow (Playwright)

```
1. page.goto(meetingUrl)
2. Wait for page load (Webex SPA takes 5-10s to initialize)
3. Handle "Open in desktop app" prompt → dismiss, choose "Join from browser"
4. If guest: enter name in input field
5. Toggle mic off, camera off
6. Click "Join meeting" / "Join" button
7. If lobby: wait for admission (host admits or timeout)
8. If password required: enter password (from botConfig.data.passcode)
9. Detect in-meeting state (toolbar visible, participant list accessible)
```

### Key Challenges

- **Desktop app prompt:** Webex aggressively pushes its desktop app. The bot must dismiss this and select "Join from your browser."
- **Cookie consent / GDPR dialogs:** May appear on first visit — need to dismiss.
- **CAPTCHA / bot detection:** Webex may detect headless browsers. Stealth plugin + realistic user agent are critical.
- **Meeting password:** Some Webex meetings require a password — must be passed through `botConfig.data.passcode`.

---

## Audio Capture Strategy

### Recommended: Browser MediaStream Capture (Same as Google Meet)

The proven approach used for Google Meet works for Webex:

1. **Find media elements:** Use `BrowserAudioService.findMediaElements()` to locate `<audio>` and `<video>` elements in the DOM that carry meeting audio
2. **Create combined stream:** `AudioContext` + `MediaStreamSource` → `MediaStreamDestination`
3. **Process audio:** `ScriptProcessorNode` or `AudioWorklet` downsamples to 16kHz mono PCM
4. **Send to WhisperLive:** Via WebSocket from browser context

**Why not Cisco Browser SDK?**
- The Cisco Browser SDK (`webex-js-sdk`) requires OAuth credentials and app registration
- It's designed for building Webex-integrated apps, not for joining arbitrary meetings as a guest
- Using Playwright to join via web client is simpler and doesn't require Webex API credentials
- The web client already handles all the WebRTC negotiation

### Audio Element Discovery

Webex's web client renders audio through standard HTML5 `<audio>` or `<video>` elements with `srcObject` set to `MediaStream`. The `BrowserAudioService.findMediaElements()` method (shared with Google Meet) scans for these:

```javascript
// Already implemented in browser-utils.global.js
const elements = document.querySelectorAll('audio, video');
const active = Array.from(elements).filter(el => 
  el.srcObject && el.srcObject.getAudioTracks().length > 0
);
```

### Speaker Detection

Webex shows active speaker indicators (e.g., blue border around video tile, speaker icon). The approach mirrors Google Meet:

1. **MutationObserver** on participant container elements watching for class changes
2. **Polling fallback** every 500ms checking speaking indicator visibility
3. Send `SPEAKER_START` / `SPEAKER_END` events to WhisperLive for speaker diarization

Webex-specific indicators to look for:
- Active speaker highlight (CSS class on video tile)
- Speaking icon in participant list
- Audio level visualization bars

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
    # Or accept PMR names: site.webex.com/meet/<name>
    if re.fullmatch(r'^[\w.-]+$', native_id):
        return f"https://web.webex.com/meet/{native_id}"
    return None
```

### 2. BotConfig Type (`services/vexa-bot/core/src/types.ts`)

```typescript
export type BotConfig = {
  platform: "google_meet" | "zoom" | "teams" | "webex",  // ADD "webex"
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

Browser launch: Webex works with Chrome (not Edge-specific like Teams), so it falls into the default Chromium path with stealth plugin.

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

Webex web client works with Chromium. The existing default browser launch path (with stealth plugin) is suitable. Key browser args already present:

```typescript
// Already in browserArgs constant:
'--use-fake-ui-for-media-stream',  // Auto-allow mic/camera
'--use-fake-device-for-media-stream',
'--disable-web-security',
// etc.
```

No additional browser configuration needed.

---

## Testing Strategy

### Phase 1: Selector Discovery & Validation

1. **Manual browser inspection:** Join a Webex meeting in a regular Chrome browser, use DevTools to document DOM structure, element selectors, and class patterns
2. **Create selector test script:** A standalone Playwright script that joins a Webex meeting and validates each selector group
3. **Screenshot checkpoints:** Like Google Meet, save screenshots at each join flow step for debugging

### Phase 2: Unit Tests

- **Selector tests:** Verify selector arrays are non-empty and well-formed
- **URL construction:** Test `construct_meeting_url` with various Webex URL formats
- **Mock admission flow:** Test `waitForWebexAdmission` with simulated DOM states

### Phase 3: Integration Tests

1. **Join flow test:** Bot successfully joins a Webex PMR (Personal Meeting Room)
2. **Audio capture test:** Verify `<audio>`/`<video>` elements are found and audio data flows
3. **WhisperLive connection:** Confirm WebSocket connects and receives transcription
4. **Speaker detection:** Verify speaker events fire when participants speak
5. **Leave flow:** Bot cleanly leaves and status updates reach bot-manager
6. **Timeout handling:** Test alone-timeout, admission-timeout, and removal detection

### Phase 4: End-to-End

- Full flow: API request → bot-manager → container → join Webex → transcribe → leave → transcript stored
- Test with multiple participants switching speakers
- Test with meeting password
- Test lobby admission and rejection

### Test Infrastructure

```
testing/
  webex/
    test_selectors.ts       # Selector validation
    test_join_flow.ts       # Join flow with real Webex meeting
    test_audio_capture.ts   # Audio pipeline verification
    test_e2e.ts             # Full end-to-end test
```

---

## Risks & Mitigations

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Webex bot detection** | Bot blocked from joining | Use stealth plugin, realistic user agent, add human-like delays. Consider rotating user agents. |
| **Webex UI changes** | Selectors break silently | Build selector arrays with multiple fallbacks (like Google Meet). Add screenshot checkpoints. Monitor for failures. |
| **No audio elements in DOM** | Transcription fails entirely | Webex may use WebRTC directly without `<audio>` elements. Fallback: intercept `RTCPeerConnection` and extract audio tracks programmatically. |
| **Webex requires sign-in** | Can't join as guest | Some Webex meetings don't allow guests. Document this limitation. Consider implementing Webex OAuth for authenticated join. |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Meeting password handling** | Bot can't join password-protected meetings | Accept password via `MeetingCreate.passcode` field (already exists). Auto-fill in join flow. |
| **Webex rate limiting** | Repeated joins throttled | Implement exponential backoff. Log rate limit headers. |
| **Different Webex editions** | UI differs between Webex Free/Business/Enterprise | Test across editions. Build flexible selector arrays. |
| **Content Security Policy** | Script injection blocked | Already handled: Playwright `bypassCSP: true` in context creation. |

### Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Webex Messaging API changes** | Transcript delivery breaks | Messaging API is stable and well-documented. Use versioned endpoints. |
| **Container resource usage** | Webex client heavier than Meet | Monitor memory/CPU. Adjust container resource limits if needed. |

---

## Implementation Phases

### Phase 1: Selector Research & Join Flow (1-2 weeks)
- [ ] Manual inspection of Webex web client DOM
- [ ] Document all selectors in `selectors.ts`
- [ ] Implement `join.ts` with screenshot checkpoints
- [ ] Implement `admission.ts` (lobby detection)
- [ ] Implement `leave.ts`
- [ ] Add `"webex"` to Platform enum and BotConfig type

### Phase 2: Audio Capture & Transcription (1-2 weeks)
- [ ] Verify audio element discovery on Webex
- [ ] Implement `recording.ts` (copy Google Meet pattern, swap selectors)
- [ ] Test WhisperLive connection and audio pipeline
- [ ] Implement speaker detection with Webex-specific indicators
- [ ] Implement `removal.ts`

### Phase 3: Bot-Manager Integration (3-5 days)
- [ ] Add Webex URL construction to `construct_meeting_url`
- [ ] Wire up `handleWebex` in `index.ts`
- [ ] Add Webex to `performGracefulLeave` dispatch
- [ ] Test full container lifecycle

### Phase 4: Webex Messaging API (Optional, 3-5 days)
- [ ] Implement transcript delivery to Webex spaces
- [ ] Add Webex bot token configuration
- [ ] Test message posting

### Phase 5: Hardening & Testing (1 week)
- [ ] Write integration tests
- [ ] Test edge cases (password, rejection, removal, alone timeout)
- [ ] Test across Webex editions (Free/Business)
- [ ] Document known limitations
- [ ] Update README

**Estimated total: 4-6 weeks**

---

## Appendix: Reference Implementation Files

When implementing, use these existing files as direct templates:

| New Webex File | Template File |
|----------------|---------------|
| `platforms/webex/index.ts` | `platforms/googlemeet/index.ts` |
| `platforms/webex/join.ts` | `platforms/googlemeet/join.ts` |
| `platforms/webex/admission.ts` | `platforms/googlemeet/admission.ts` |
| `platforms/webex/recording.ts` | `platforms/googlemeet/recording.ts` |
| `platforms/webex/removal.ts` | `platforms/googlemeet/removal.ts` |
| `platforms/webex/leave.ts` | `platforms/googlemeet/leave.ts` |
| `platforms/webex/selectors.ts` | `platforms/googlemeet/selectors.ts` |

The Google Meet implementation is the closest analog because both platforms:
- Use Chrome/Chromium (not Edge like Teams)
- Support guest joining via web
- Have similar lobby/admission flows
- Render audio through standard HTML media elements
