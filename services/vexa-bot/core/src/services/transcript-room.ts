import { log } from '../utils';
import WebSocket from 'ws';
import http from 'http';

export interface TranscriptRoomConfig {
  /** Base URL of the transcript-room service, e.g. http://localhost:8790 */
  baseUrl: string;
}

export interface TranscriptRoom {
  roomToken: string;
  viewerUrl: string;
  ingestUrl: string;
}

export class TranscriptRoomClient {
  private config: TranscriptRoomConfig;
  private room: TranscriptRoom | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log('[TranscriptRoom] WebSocket not open, queuing not implemented — segment dropped');
      return;
    }

    const segment = {
      text,
      speaker: speaker || null,
      timestamp: timestamp || new Date().toISOString(),
    };

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

    const wsUrl = this.room.ingestUrl;
    log(`[TranscriptRoom] Connecting ingest WebSocket: ${wsUrl}`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      log('[TranscriptRoom] Ingest WebSocket connected');
    });

    this.ws.on('close', () => {
      log('[TranscriptRoom] Ingest WebSocket closed');
      // Reconnect if room still active
      if (this.room) {
        this.reconnectTimer = setTimeout(() => this.connectIngest(), 3000);
      }
    });

    this.ws.on('error', (err) => {
      log(`[TranscriptRoom] Ingest WebSocket error: ${err.message}`);
    });
  }

  private httpPost<T = any>(url: string, body: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data as any); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      http.get({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }
}
