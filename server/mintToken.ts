import { AccessToken } from "livekit-server-sdk";

export const ROOM_NAME = "schuteiraDisc";

export async function mintToken(options: {
  apiKey: string;
  apiSecret: string;
  name: string;
}): Promise<string> {
  const nick = options.name.trim().slice(0, 24) || "Visitante";
  const identity = `${nick}-${crypto.randomUUID()}`;
  const token = new AccessToken(options.apiKey, options.apiSecret, {
    identity,
    name: nick,
    ttl: "6h",
  });
  token.addGrant({
    roomJoin: true,
    room: ROOM_NAME,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return token.toJwt();
}
