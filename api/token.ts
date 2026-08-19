import { mintToken } from "../server/mintToken";

type TokenRequest = {
  method?: string;
  query?: { name?: string | string[] };
};

type TokenResponse = {
  status: (code: number) => TokenResponse;
  json: (body: unknown) => void;
};

export default async function handler(req: TokenRequest, res: TokenResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    res.status(500).json({ error: "LiveKit não configurado" });
    return;
  }

  const raw = req.query?.name;
  const name = Array.isArray(raw) ? raw[0] : raw;

  try {
    const token = await mintToken({ apiKey, apiSecret, name: name ?? "Visitante" });
    res.status(200).json({ token });
  } catch {
    res.status(500).json({ error: "Não deu para criar o token" });
  }
}
