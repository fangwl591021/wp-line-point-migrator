export interface GatewayEnv {
  DB: D1Database;
  CHANNEL_CONFIG_JSON: string;
  ADMIN_TOKEN?: string;
}

export interface ChannelConfig {
  channelSecret: string;
  forwardUrl: string;
  label?: string;
}

export interface LineWebhookPayload {
  destination?: string;
  events?: LineWebhookEvent[];
}

export interface LineWebhookEvent {
  type?: string;
  replyToken?: string;
  timestamp?: number;
  source?: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    type?: string;
    text?: string;
    id?: string;
  };
}
