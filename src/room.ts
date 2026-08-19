import { joinRoom, selfId } from "trystero";
import { getTurnConfig } from "./ice";

export const APP_ID = "schuteiraDisc";
export const ROOM_ID = "global";

type StreamKind = "audio" | "screen";
type LinkState = "connecting" | "connected" | "failed";

type PeerState = {
  nick: string;
  muted: boolean;
  sharing: boolean;
  speaking: boolean;
  link: LinkState;
};

export type PeerInfo = PeerState & {
  id: string;
  isSelf: boolean;
};

export type CallSession = {
  selfId: string;
  getPeers: () => PeerInfo[];
  setMuted: (muted: boolean) => void;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
  leave: () => void;
};

type CallHandlers = {
  onPeers: (peers: PeerInfo[]) => void;
  onRemoteAudio: (peerId: string, stream: MediaStream | null) => void;
  onRemoteScreen: (peerId: string, stream: MediaStream | null) => void;
  onLocalScreen: (stream: MediaStream | null) => void;
  onStatus: (message: string) => void;
  onError: (message: string) => void;
};

function emptyPeer(): PeerState {
  return { nick: "Alguém", muted: false, sharing: false, speaking: false, link: "connecting" };
}

function watchSpeaking(
  stream: MediaStream,
  audioCtx: AudioContext,
  onChange: (speaking: boolean) => void,
): () => void {
  const track = stream.getAudioTracks()[0];
  if (!track) return () => {};

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let speaking = false;
  let raf = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) {
      const v = (sample - 128) / 128;
      sum += v * v;
    }
    const next = Math.sqrt(sum / data.length) > 0.045 && track.enabled;
    if (next !== speaking) {
      speaking = next;
      onChange(speaking);
    }
    raf = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    source.disconnect();
    analyser.disconnect();
  };
}

export async function startCall(
  nickname: string,
  handlers: CallHandlers,
): Promise<CallSession> {
  const audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  const turnConfig = await getTurnConfig();

  const room = joinRoom(
    {
      appId: APP_ID,
      turnConfig,
      relayConfig: { redundancy: 4 },
      rtcConfig: { iceCandidatePoolSize: 8 },
    },
    ROOM_ID,
  );

  const nickAction = room.makeAction<string>("nick");
  const muteAction = room.makeAction<{ muted: boolean }>("mute");
  const screenAction = room.makeAction<{ sharing: boolean }>("screen");

  const peers = new Map<string, PeerState>();
  const stopSpeaking = new Map<string, () => void>();
  let screenStream: MediaStream | null = null;
  let localMuted = false;
  let left = false;

  const selfState = (): PeerState => ({
    nick: nickname,
    muted: localMuted,
    sharing: Boolean(screenStream),
    speaking: false,
    link: "connected",
  });

  const emitPeers = () => {
    const list: PeerInfo[] = [
      { id: selfId, isSelf: true, ...selfState(), speaking: peers.get(selfId)?.speaking ?? false },
    ];
    for (const [id, state] of peers) {
      if (id === selfId) continue;
      list.push({ id, isSelf: false, ...state });
    }
    handlers.onPeers(list);
  };

  const setPeer = (id: string, patch: Partial<PeerState>) => {
    const current = peers.get(id) ?? emptyPeer();
    peers.set(id, { ...current, ...patch });
    emitPeers();
  };

  const sendPresence = (peerId?: string) => {
    const target = peerId ? { target: peerId } : undefined;
    nickAction.send(nickname, target);
    muteAction.send({ muted: localMuted }, target);
    screenAction.send({ sharing: Boolean(screenStream) }, target);
  };

  const sendMedia = (peerId?: string) => {
    const target = peerId ? { target: peerId } : undefined;
    room.addStream(micStream, { ...target, metadata: { kind: "audio" satisfies StreamKind } });
    if (screenStream) {
      room.addStream(screenStream, {
        ...target,
        metadata: { kind: "screen" satisfies StreamKind },
      });
    }
  };

  setPeer(selfId, selfState());
  stopSpeaking.set(
    selfId,
    watchSpeaking(micStream, audioCtx, (speaking) => setPeer(selfId, { speaking })),
  );

  nickAction.onMessage = (nick, { peerId }) => setPeer(peerId, { nick });
  muteAction.onMessage = ({ muted }, { peerId }) => setPeer(peerId, { muted });
  screenAction.onMessage = ({ sharing }, { peerId }) => {
    setPeer(peerId, { sharing });
    if (!sharing) handlers.onRemoteScreen(peerId, null);
  };

  const iceRestarted = new Set<string>();

  const watchLink = (peerId: string) => {
    const pc = room.getPeers()[peerId];
    if (!pc) return;

    const sync = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        setPeer(peerId, { link: "connected" });
        sendMedia(peerId);
        sendPresence(peerId);
        return;
      }
      if (state === "failed") {
        setPeer(peerId, { link: "failed" });
        if (!iceRestarted.has(peerId)) {
          iceRestarted.add(peerId);
          try {
            pc.restartIce();
          } catch {
            // ignore
          }
        }
        return;
      }
      if (state === "disconnected") {
        setPeer(peerId, { link: "connecting" });
        return;
      }
      setPeer(peerId, { link: "connecting" });
    };

    pc.addEventListener("connectionstatechange", sync);
    sync();
  };

  room.onPeerJoin = (peerId) => {
    setPeer(peerId, emptyPeer());
    sendPresence(peerId);
    sendMedia(peerId);
    watchLink(peerId);
    const others = Object.keys(room.getPeers()).length;
    handlers.onStatus(others ? `${others + 1} pessoas na sala` : "Só você por enquanto");
  };

  room.onPeerLeave = (peerId) => {
    stopSpeaking.get(peerId)?.();
    stopSpeaking.delete(peerId);
    peers.delete(peerId);
    handlers.onRemoteAudio(peerId, null);
    handlers.onRemoteScreen(peerId, null);
    emitPeers();
    const others = Object.keys(room.getPeers()).length;
    handlers.onStatus(others ? `${others + 1} pessoas na sala` : "Só você por enquanto");
  };

  room.onPeerStream = (stream, peerId, metadata) => {
    const kind: StreamKind =
      metadata && typeof metadata === "object" && "kind" in metadata
        ? ((metadata as { kind?: StreamKind }).kind ?? "audio")
        : stream.getVideoTracks().length
          ? "screen"
          : "audio";

    if (kind === "screen" || stream.getVideoTracks().length > 0) {
      setPeer(peerId, { sharing: true });
      handlers.onRemoteScreen(peerId, stream);
      const video = stream.getVideoTracks()[0];
      video?.addEventListener("ended", () => {
        setPeer(peerId, { sharing: false });
        handlers.onRemoteScreen(peerId, null);
      });
      return;
    }

    stopSpeaking.get(peerId)?.();
    stopSpeaking.set(
      peerId,
      watchSpeaking(stream, audioCtx, (speaking) => setPeer(peerId, { speaking })),
    );
    handlers.onRemoteAudio(peerId, stream);
  };

  sendMedia();
  sendPresence();
  handlers.onStatus("Procurando gente na sala…");
  window.setTimeout(() => {
    if (left || Object.keys(room.getPeers()).length > 0) return;
    handlers.onStatus("Só você por enquanto");
  }, 8000);

  const stopScreenShare = () => {
    if (!screenStream) return;
    room.removeStream(screenStream);
    for (const track of screenStream.getTracks()) track.stop();
    screenStream = null;
    screenAction.send({ sharing: false });
    setPeer(selfId, { sharing: false });
    handlers.onLocalScreen(null);
  };

  return {
    selfId,
    getPeers: () =>
      [...peers.entries()].map(([id, state]) => ({
        id,
        isSelf: id === selfId,
        ...state,
      })),
    setMuted: (muted) => {
      localMuted = muted;
      for (const track of micStream.getAudioTracks()) track.enabled = !muted;
      muteAction.send({ muted });
      setPeer(selfId, { muted, speaking: muted ? false : peers.get(selfId)?.speaking ?? false });
    },
    startScreenShare: async () => {
      if (screenStream) return;
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
        systemAudio: "include",
      } as DisplayMediaStreamOptions);
      screenStream = stream;
      room.addStream(stream, { metadata: { kind: "screen" satisfies StreamKind } });
      screenAction.send({ sharing: true });
      setPeer(selfId, { sharing: true });
      handlers.onLocalScreen(stream);
      if (!stream.getAudioTracks().length) {
        handlers.onStatus(
          "Tela no ar. Para mandar o som, marque “Compartilhar áudio da aba” na janela do Chrome.",
        );
      }
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (!left) stopScreenShare();
      });
    },
    stopScreenShare,
    leave: () => {
      left = true;
      stopScreenShare();
      for (const stop of stopSpeaking.values()) stop();
      stopSpeaking.clear();
      for (const track of micStream.getTracks()) track.stop();
      void audioCtx.close();
      room.leave();
    },
  };
}

export function randomNick(): string {
  const n = Math.floor(100 + Math.random() * 900);
  return `Visitante ${n}`;
}
