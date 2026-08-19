import type { TurnServerConfig } from "@trystero-p2p/mqtt";

const STATIC_SECRET = "openrelayprojectsecret";

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function openRelayStaticAuth(): Promise<TurnServerConfig> {
  const expiry = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const username = `${expiry}:schuteiraDisc`;
  const credential = await hmacSha1Base64(STATIC_SECRET, username);
  return {
    urls: [
      "turn:staticauth.openrelay.metered.ca:80",
      "turn:staticauth.openrelay.metered.ca:80?transport=tcp",
      "turn:staticauth.openrelay.metered.ca:443",
      "turn:staticauth.openrelay.metered.ca:443?transport=tcp",
      "turns:staticauth.openrelay.metered.ca:443?transport=tcp",
    ],
    username,
    credential,
  };
}

const openRelayPassword: TurnServerConfig = {
  urls: [
    "turn:openrelay.metered.ca:80",
    "turn:openrelay.metered.ca:80?transport=tcp",
    "turn:openrelay.metered.ca:443",
    "turn:openrelay.metered.ca:443?transport=tcp",
    "turns:openrelay.metered.ca:443?transport=tcp",
  ],
  username: "openrelayproject",
  credential: "openrelayproject",
};

function envTurn(): TurnServerConfig[] | null {
  const urls = import.meta.env.VITE_TURN_URLS?.split(",").map((url) => url.trim()).filter(Boolean);
  const username = import.meta.env.VITE_TURN_USERNAME;
  const credential = import.meta.env.VITE_TURN_CREDENTIAL;
  if (!urls?.length || !username || !credential) return null;
  return [{ urls, username, credential }];
}

export async function getTurnConfig(): Promise<TurnServerConfig[]> {
  const endpoint = import.meta.env.VITE_METERED_TURN_ENDPOINT;
  if (endpoint) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const iceServers = (await response.json()) as TurnServerConfig[];
        const turns = iceServers.filter((server) => {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          return urls.some((url) => url.startsWith("turn"));
        });
        if (turns.length) return turns;
      }
    } catch {
      // cai no Open Relay
    }
  }

  const custom = envTurn();
  if (custom) return custom;

  return [await openRelayStaticAuth(), openRelayPassword];
}
