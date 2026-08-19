import { AccessToken } from "livekit-server-sdk";

export const runtime = "nodejs";

const ROOM_NAME = "schuteiraDisc";

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function GET(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    return json(
      {
        error:
          "LiveKit não configurado. Na Vercel, defina LIVEKIT_API_KEY e LIVEKIT_API_SECRET no ambiente Production.",
      },
      500,
    );
  }

  const name = new URL(request.url).searchParams.get("name") ?? "Visitante";
  const nick = name.trim().slice(0, 24) || "Visitante";

  try {
    const token = new AccessToken(apiKey, apiSecret, {
      identity: `${nick}-${crypto.randomUUID()}`,
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
    return json({ token: await token.toJwt() });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erro desconhecido";
    return json({ error: `Não deu para criar o token (${detail})` }, 500);
  }
}
