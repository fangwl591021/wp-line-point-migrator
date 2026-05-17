export interface GatewayEnv {
  DB: D1Database;
  MLM_WORKER?: Fetcher;
  CHANNEL_CONFIG_JSON: string;
  ADMIN_TOKEN?: string;
  MLM_FORWARD_TOKEN?: string;
  MLM_FORWARD_URL?: string;
  POINT_API_KEY?: string;
  WETW_API_KEY?: string;
  WETW_MEMBER_API_URL?: string;
  WETW_POINT_API_BASE_URL?: string;
}

export interface ChannelConfig {
  channelSecret: string;
  forwardUrl: string;
  mlmForwardUrl?: string;
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
