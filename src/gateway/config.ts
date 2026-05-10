import type { ChannelConfig, GatewayEnv } from "./types.js";

export function getChannelConfig(env: GatewayEnv, channelKey: string): ChannelConfig | undefined {
  const config = JSON.parse(env.CHANNEL_CONFIG_JSON || "{}") as Record<string, ChannelConfig>;
  return config[channelKey];
}
