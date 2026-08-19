import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";

export const ROOM_NAME = "schuteiraDisc";

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

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

function mediaStreamFromTrack(track: { mediaStream?: MediaStream; mediaStreamTrack: MediaStreamTrack }) {
  return track.mediaStream ?? new MediaStream([track.mediaStreamTrack]);
}

function participantState(participant: Participant, link: LinkState): PeerState {
  return {
    nick: participant.name || participant.identity,
    muted: !participant.isMicrophoneEnabled,
    sharing: Boolean(participant.getTrackPublication(Track.Source.ScreenShare)),
    speaking: participant.isSpeaking,
    link,
  };
}

async function fetchJoinToken(name: string): Promise<string> {
  const response = await fetch(`/api/token?name=${encodeURIComponent(name)}`);
  let body: { token?: string; error?: string } = {};
  try {
    body = (await response.json()) as { token?: string; error?: string };
  } catch {
    body = {};
  }
  if (!response.ok || !body.token) {
    throw new TokenError(body.error ?? "Não deu para entrar. Confira as chaves do LiveKit na Vercel.");
  }
  return body.token;
}

export async function startCall(
  nickname: string,
  handlers: CallHandlers,
): Promise<CallSession> {
  const livekitUrl = import.meta.env.VITE_LIVEKIT_URL;
  if (!livekitUrl) {
    throw new TokenError("Falta VITE_LIVEKIT_URL no ambiente.");
  }

  const token = await fetchJoinToken(nickname);
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const screenMix = new Map<string, MediaStream>();

  const roomLink = (): LinkState => {
    if (room.state === ConnectionState.Connected) return "connected";
    if (room.state === ConnectionState.Disconnected) return "failed";
    return "connecting";
  };

  const emitPeers = () => {
    const link = roomLink();
    const list: PeerInfo[] = [
      {
        id: room.localParticipant.identity,
        isSelf: true,
        ...participantState(room.localParticipant, "connected"),
      },
    ];
    for (const participant of room.remoteParticipants.values()) {
      list.push({
        id: participant.identity,
        isSelf: false,
        ...participantState(participant, link),
      });
    }
    handlers.onPeers(list);
  };

  const statusCount = () => {
    const total = room.remoteParticipants.size + 1;
    handlers.onStatus(total === 1 ? "Só você por enquanto" : `${total} pessoas na sala`);
  };

  const publishScreen = (peerId: string) => {
    const mixed = screenMix.get(peerId);
    if (!mixed || mixed.getVideoTracks().length === 0) {
      handlers.onRemoteScreen(peerId, null);
      return;
    }
    handlers.onRemoteScreen(peerId, mixed);
  };

  const addScreenTrack = (peerId: string, track: RemoteTrack) => {
    let mixed = screenMix.get(peerId);
    if (!mixed) {
      mixed = new MediaStream();
      screenMix.set(peerId, mixed);
    }
    const mediaTrack = track.mediaStreamTrack;
    if (!mixed.getTracks().some((existing) => existing.id === mediaTrack.id)) {
      mixed.addTrack(mediaTrack);
    }
    publishScreen(peerId);
  };

  const removeScreenTrack = (peerId: string, track: RemoteTrack) => {
    const mixed = screenMix.get(peerId);
    if (!mixed) return;
    mixed.removeTrack(track.mediaStreamTrack);
    if (mixed.getVideoTracks().length === 0) {
      screenMix.delete(peerId);
      handlers.onRemoteScreen(peerId, null);
      return;
    }
    publishScreen(peerId);
  };

  const handleRemoteTrack = (
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (track.source === Track.Source.Microphone) {
      handlers.onRemoteAudio(participant.identity, mediaStreamFromTrack(track));
    }
    if (track.source === Track.Source.ScreenShare || track.source === Track.Source.ScreenShareAudio) {
      addScreenTrack(participant.identity, track);
    }
    emitPeers();
  };

  room.on(RoomEvent.ParticipantConnected, () => {
    emitPeers();
    statusCount();
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    screenMix.delete(participant.identity);
    handlers.onRemoteAudio(participant.identity, null);
    handlers.onRemoteScreen(participant.identity, null);
    emitPeers();
    statusCount();
  });

  room.on(RoomEvent.TrackSubscribed, handleRemoteTrack);

  room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
    if (track.source === Track.Source.Microphone) {
      handlers.onRemoteAudio(participant.identity, null);
    }
    if (track.source === Track.Source.ScreenShare || track.source === Track.Source.ScreenShareAudio) {
      removeScreenTrack(participant.identity, track);
    }
    emitPeers();
  });

  room.on(RoomEvent.ActiveSpeakersChanged, () => emitPeers());
  room.on(RoomEvent.TrackMuted, () => emitPeers());
  room.on(RoomEvent.TrackUnmuted, () => emitPeers());
  room.on(RoomEvent.ParticipantMetadataChanged, () => emitPeers());

  room.on(RoomEvent.LocalTrackPublished, (publication) => {
    if (publication.source === Track.Source.ScreenShare && publication.track) {
      handlers.onLocalScreen(mediaStreamFromTrack(publication.track));
    }
    emitPeers();
  });

  room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
    if (publication.source === Track.Source.ScreenShare) {
      handlers.onLocalScreen(null);
    }
    emitPeers();
  });

  room.on(RoomEvent.ConnectionStateChanged, (state) => {
    if (state === ConnectionState.Disconnected) {
      handlers.onError("Desconectado da call.");
    }
    emitPeers();
  });

  handlers.onStatus("Entrando na call…");
  await room.connect(livekitUrl, token);

  try {
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch (error) {
    await room.disconnect();
    throw error;
  }

  emitPeers();
  statusCount();

  return {
    selfId: room.localParticipant.identity,
    getPeers: () => {
      const link = roomLink();
      return [
        {
          id: room.localParticipant.identity,
          isSelf: true,
          ...participantState(room.localParticipant, "connected"),
        },
        ...[...room.remoteParticipants.values()].map((participant) => ({
          id: participant.identity,
          isSelf: false,
          ...participantState(participant, link),
        })),
      ];
    },
    setMuted: (muted) => {
      void room.localParticipant.setMicrophoneEnabled(!muted);
    },
    startScreenShare: async () => {
      await room.localParticipant.setScreenShareEnabled(true, { audio: true });
      const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      if (publication?.track) {
        handlers.onLocalScreen(mediaStreamFromTrack(publication.track));
      }
      if (!room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track) {
        handlers.onStatus(
          "Tela no ar. Para mandar o som, marque “Compartilhar áudio da aba” na janela do Chrome.",
        );
      }
    },
    stopScreenShare: () => {
      void room.localParticipant.setScreenShareEnabled(false);
      handlers.onLocalScreen(null);
    },
    leave: () => {
      void room.disconnect();
    },
  };
}

export function randomNick(): string {
  const n = Math.floor(100 + Math.random() * 900);
  return `Visitante ${n}`;
}
