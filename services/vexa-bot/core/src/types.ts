export interface WebexBotData {
  access_token: string;
  hostEmail?: string;
  transcriptUrlCallback?: string;
  transcriptDeliveryCallback?: string;
  [key: string]: any;
}

export type BotConfig = {
  platform: "google_meet" | "zoom" | "teams" | "webex",
  meetingUrl: string | null,
  botName: string,
  token: string,  // MeetingToken (HS256 JWT)
  connectionId: string,
  nativeMeetingId: string,
  language?: string | null,
  task?: string | null,
  redisUrl: string,
  container_name?: string,
  automaticLeave: {
    waitingRoomTimeout: number,
    noOneJoinedTimeout: number,
    everyoneLeftTimeout: number
  },
  reconnectionIntervalMs?: number,
  meeting_id: number,  // Required, not optional
  botManagerCallbackUrl?: string;
  data?: WebexBotData | {
    [key: string]: any;
  };
}
