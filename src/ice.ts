import type { TurnServerConfig } from "@trystero-p2p/torrent";

const OPEN_RELAY_USER = "openrelayproject";
const OPEN_RELAY_PASS = "openrelayproject";

const openRelay: TurnServerConfig[] = [
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:80?transport=tcp",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
      "turns:openrelay.metered.ca:443?transport=tcp",
    ],
    username: OPEN_RELAY_USER,
    credential: OPEN_RELAY_PASS,
  },
];

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
      // usa o Open Relay abaixo
    }
  }

  return envTurn() ?? openRelay;
}
