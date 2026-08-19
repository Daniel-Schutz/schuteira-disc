import "./style.css";
import { randomNick, startCall, type CallSession, type PeerInfo } from "./room";

const gate = document.querySelector<HTMLDivElement>("#gate")!;
const app = document.querySelector<HTMLDivElement>("#app")!;
const joinForm = document.querySelector<HTMLFormElement>("#join-form")!;
const nickInput = document.querySelector<HTMLInputElement>("#nick")!;
const joinBtn = document.querySelector<HTMLButtonElement>("#join-btn")!;
const gateError = document.querySelector<HTMLParagraphElement>("#gate-error")!;
const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const peersEl = document.querySelector<HTMLUListElement>("#peers")!;
const screensEl = document.querySelector<HTMLDivElement>("#screens")!;
const emptyStage = document.querySelector<HTMLDivElement>("#empty-stage")!;
const muteBtn = document.querySelector<HTMLButtonElement>("#mute-btn")!;
const shareBtn = document.querySelector<HTMLButtonElement>("#share-btn")!;
const leaveBtn = document.querySelector<HTMLButtonElement>("#leave-btn")!;

const remoteAudio = new Map<string, HTMLAudioElement>();
const screenTiles = new Map<string, HTMLElement>();
let session: CallSession | null = null;
let muted = false;
let sharing = false;
let peerNames = new Map<string, string>();

nickInput.value = randomNick();
nickInput.select();

function showError(message: string) {
  gateError.hidden = false;
  gateError.textContent = message;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function renderPeers(peers: PeerInfo[]) {
  peerNames = new Map(peers.map((peer) => [peer.id, peer.nick]));
  peersEl.replaceChildren(
    ...peers.map((peer) => {
      const li = document.createElement("li");
      li.className = `peer${peer.isSelf ? " self" : ""}${peer.speaking && !peer.muted ? " speaking" : ""}`;
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = initials(peer.nick) || "?";
      const meta = document.createElement("div");
      meta.className = "peer-meta";
      const name = document.createElement("strong");
      name.textContent = peer.isSelf ? `${peer.nick} (você)` : peer.nick;
      const state = document.createElement("span");
      const bits = [
        peer.muted ? "mudo" : peer.speaking ? "falando" : "conectado",
        peer.sharing ? "compartilhando tela" : "",
      ].filter(Boolean);
      state.textContent = bits.join(" · ");
      meta.append(name, state);
      li.append(avatar, meta);
      return li;
    }),
  );
}

function syncStage() {
  emptyStage.hidden = screensEl.childElementCount > 0;
}

function upsertScreen(peerId: string, stream: MediaStream, label: string) {
  let tile = screenTiles.get(peerId);
  if (!tile) {
    tile = document.createElement("figure");
    tile.className = "screen-tile";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    const caption = document.createElement("figcaption");
    tile.append(video, caption);
    screensEl.append(tile);
    screenTiles.set(peerId, tile);
  }
  const video = tile.querySelector("video")!;
  const caption = tile.querySelector("figcaption")!;
  video.srcObject = stream;
  caption.textContent = label;
  void video.play().catch(() => undefined);
  syncStage();
}

function removeScreen(peerId: string) {
  const tile = screenTiles.get(peerId);
  if (!tile) return;
  const video = tile.querySelector("video");
  if (video) video.srcObject = null;
  tile.remove();
  screenTiles.delete(peerId);
  syncStage();
}

function setRemoteAudio(peerId: string, stream: MediaStream | null) {
  remoteAudio.get(peerId)?.pause();
  remoteAudio.get(peerId)?.remove();
  remoteAudio.delete(peerId);
  if (!stream) return;
  const audio = new Audio();
  audio.autoplay = true;
  audio.srcObject = stream;
  audio.play().catch(() => undefined);
  remoteAudio.set(peerId, audio);
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nickname = nickInput.value.trim() || randomNick();
  joinBtn.disabled = true;
  gateError.hidden = true;

  try {
    session = await startCall(nickname, {
      onPeers: renderPeers,
      onStatus: (message) => {
        statusEl.textContent = message;
      },
      onError: (message) => {
        statusEl.textContent = message;
      },
      onRemoteAudio: setRemoteAudio,
      onRemoteScreen: (peerId, stream) => {
        if (!stream) {
          removeScreen(peerId);
          return;
        }
        upsertScreen(peerId, stream, peerNames.get(peerId) ?? "Alguém");
      },
      onLocalScreen: (stream) => {
        sharing = Boolean(stream);
        shareBtn.setAttribute("aria-pressed", String(sharing));
        shareBtn.querySelector(".label")!.textContent = sharing
          ? "Parar tela"
          : "Compartilhar tela";
        if (!stream || !session) {
          removeScreen("self");
          return;
        }
        upsertScreen("self", stream, "Você");
      },
    });

    gate.hidden = true;
    app.hidden = false;
  } catch (error) {
    const denied =
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
    showError(
      denied
        ? "Precisa permitir o microfone para entrar na call."
        : "Não deu para ligar o microfone. Confira se outro app não está usando ele.",
    );
    joinBtn.disabled = false;
  }
});

muteBtn.addEventListener("click", () => {
  if (!session) return;
  muted = !muted;
  session.setMuted(muted);
  muteBtn.setAttribute("aria-pressed", String(muted));
  muteBtn.querySelector(".label")!.textContent = muted ? "Ativar mic" : "Silenciar";
});

shareBtn.addEventListener("click", async () => {
  if (!session) return;
  if (sharing) {
    session.stopScreenShare();
    return;
  }
  try {
    await session.startScreenShare();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") return;
    statusEl.textContent = "Não deu para compartilhar a tela.";
  }
});

function leaveCall() {
  session?.leave();
  session = null;
  for (const audio of remoteAudio.values()) {
    audio.pause();
    audio.srcObject = null;
  }
  remoteAudio.clear();
  for (const id of [...screenTiles.keys()]) removeScreen(id);
  peersEl.replaceChildren();
  muted = false;
  sharing = false;
  muteBtn.setAttribute("aria-pressed", "false");
  muteBtn.querySelector(".label")!.textContent = "Silenciar";
  shareBtn.setAttribute("aria-pressed", "false");
  shareBtn.querySelector(".label")!.textContent = "Compartilhar tela";
  app.hidden = true;
  gate.hidden = false;
  joinBtn.disabled = false;
}

leaveBtn.addEventListener("click", leaveCall);
window.addEventListener("beforeunload", () => session?.leave());
