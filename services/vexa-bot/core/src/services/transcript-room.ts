import { log } from '../utils';

export interface TranscriptRoomConfig {
  /** Base URL of the transcript-room service, e.g. http://localhost:8790 */
  baseUrl: string;
  /** Shared secret for room authentication (matches ROOM_SECRET env var on server) */
  secret?: string;
}

const MAX_QUEUED_SEGMENTS = 200;

export interface TranscriptRoom {
  roomToken: string;
  viewerUrl: string;
  ingestUrl: string;
}

export class TranscriptRoomClient {
  private config: TranscriptRoomConfig;
  private room: TranscriptRoom | null = null;
  private ws: globalThis.WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;
  private segmentQueue: Array<{ text: string; speaker: string | null; timestamp: string }> = [];

  constructor(config: TranscriptRoomConfig) {
    this.config = config;
  }

  /**
   * Create a new transcript room and open the ingest WebSocket.
   */
  async createRoom(meetingId?: string): Promise<TranscriptRoom> {
    const url = `${this.config.baseUrl}/api/rooms`;
    const body = JSON.stringify({
      meetingId: meetingId || null,
      ttlMinutes: 60,
    });

    const room = await this.httpPost<TranscriptRoom>(url, body);
    this.room = room;
    log(`[TranscriptRoom] Room created: ${room.viewerUrl}`);

    // Open ingest WebSocket
    this.connectIngest();

    return room;
  }

  /**
   * Send a transcript segment to the room.
   */
  sendSegment(text: string, speaker?: string, timestamp?: string): void {
    const segment = {
      text,
      speaker: speaker || null,
      timestamp: timestamp || new Date().toISOString(),
    };

    if (!this.ws || this.ws.readyState !== globalThis.WebSocket.OPEN) {
      // Queue segments while WebSocket is reconnecting
      if (this.segmentQueue.length >= MAX_QUEUED_SEGMENTS) {
        this.segmentQueue.shift(); // drop oldest to stay bounded
      }
      this.segmentQueue.push(segment);
      log(`[TranscriptRoom] WebSocket not open, segment queued (${this.segmentQueue.length}/${MAX_QUEUED_SEGMENTS})`);
      return;
    }

    try {
      this.ws.send(JSON.stringify(segment));
    } catch (err: any) {
      log(`[TranscriptRoom] Error sending segment: ${err.message}`);
    }
  }

  /**
   * Signal that the meeting has ended. Starts the room's expiry countdown.
   */
  async endRoom(): Promise<void> {
    if (!this.room) return;

    try {
      const url = `${this.config.baseUrl}/api/room/${this.room.roomToken}/end`;
      this.ended = true;
      await this.httpPost(url, '{}');
      log('[TranscriptRoom] Room ended, expiry countdown started');
    } catch (err: any) {
      log(`[TranscriptRoom] Error ending room: ${err.message}`);
    }
  }

  /**
   * Get the full transcript as plain text.
   */
  async getTranscriptText(): Promise<string> {
    if (!this.room) return '';

    try {
      const url = `${this.config.baseUrl}/api/room/${this.room.roomToken}/transcript?format=text`;
      return await this.httpGet(url);
    } catch (err: any) {
      log(`[TranscriptRoom] Error fetching transcript: ${err.message}`);
      return '';
    }
  }

  /**
   * Get the viewer URL for sharing.
   */
  getViewerUrl(): string | null {
    return this.room?.viewerUrl || null;
  }

  /**
   * Clean up WebSocket and timers.
   */
  cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.room = null;
  }

  // ── Private ───────────────────────────────────────────

  private connectIngest(): void {
    if (!this.room) return;

    if (!globalThis.WebSocket) {
      throw new Error(
        '[TranscriptRoom] globalThis.WebSocket is not available. ' +
        'Node.js >= 21 is required for native WebSocket support. ' +
        'Please upgrade Node.js or polyfill WebSocket.'
      );
    }

    let wsUrl = this.room.ingestUrl;
    // Append secret as query parameter for WebSocket auth (can't set custom headers)
    if (this.config.secret) {
      const sep = wsUrl.includes('?') ? '&' : '?';
      wsUrl += `${sep}secret=${encodeURIComponent(this.config.secret)}`;
    }
    log(`[TranscriptRoom] Connecting ingest WebSocket: ${this.room.ingestUrl}`);

    this.ws = new globalThis.WebSocket(wsUrl);

    this.ws.onopen = () => {
      log('[TranscriptRoom] Ingest WebSocket connected');
      // Flush queued segments
      while (this.segmentQueue.length > 0) {
        const seg = this.segmentQueue.shift()!;
        try {
          this.ws!.send(JSON.stringify(seg));
        } catch (err: any) {
          log(`[TranscriptRoom] Error flushing queued segment: ${err.message}`);
          break;
        }
      }
    };

    this.ws.onclose = () => {
      log('[TranscriptRoom] Ingest WebSocket closed');
      // Reconnect only if room still active and not ended
      if (this.room && !this.ended) {
        this.reconnectTimer = setTimeout(() => this.connectIngest(), 3000);
      }
    };

    this.ws.onerror = (ev) => {
      log(`[TranscriptRoom] Ingest WebSocket error`);
    };
  }

  private async httpPost<T = any>(url: string, body: string): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.secret) {
      headers['X-Room-Secret'] = this.config.secret;
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch { return text as any; }
  }

  private async httpGet(url: string): Promise<string> {
    const resp = await fetch(url);
    return resp.text();
  }
}
