import "./style.css";
import { randomNick, startCall, TokenError, type CallSession, type PeerInfo } from "./room";

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
const stageBar = document.querySelector<HTMLDivElement>("#stage-bar")!;
const viewModes = document.querySelector<HTMLDivElement>("#view-modes")!;
const muteBtn = document.querySelector<HTMLButtonElement>("#mute-btn")!;
const shareBtn = document.querySelector<HTMLButtonElement>("#share-btn")!;
const leaveBtn = document.querySelector<HTMLButtonElement>("#leave-btn")!;

const remoteAudio = new Map<string, HTMLAudioElement>();
const screenAudio = new Map<string, HTMLAudioElement>();
const screenTiles = new Map<string, HTMLElement>();
const screenLabels = new Map<string, string>();
let session: CallSession | null = null;
let muted = false;
let sharing = false;
let focusedScreenId: string | null = null;
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
      li.className = `peer${peer.isSelf ? " self" : ""}${peer.speaking && !peer.muted ? " speaking" : ""}${!peer.isSelf && peer.link === "failed" ? " failed" : ""}`;
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = initials(peer.nick) || "?";
      const meta = document.createElement("div");
      meta.className = "peer-meta";
      const name = document.createElement("strong");
      name.textContent = peer.isSelf ? `${peer.nick} (você)` : peer.nick;
      const state = document.createElement("span");
      const bits = [
        peer.isSelf
          ? peer.muted
            ? "mudo"
            : peer.speaking
              ? "falando"
              : "conectado"
          : peer.link === "failed"
            ? "sem conexão"
            : peer.link === "connecting"
              ? "conectando…"
              : peer.muted
                ? "mudo"
                : peer.speaking
                  ? "falando"
                  : "conectado",
        peer.sharing ? "compartilhando tela" : "",
      ].filter(Boolean);
      state.textContent = bits.join(" · ");
      meta.append(name, state);
      li.append(avatar, meta);
      return li;
    }),
  );

  let labelsChanged = false;
  for (const [id, tile] of screenTiles) {
    const label = id === "self" ? "Você" : (peerNames.get(id) ?? screenLabels.get(id) ?? "Alguém");
    if (screenLabels.get(id) === label) continue;
    screenLabels.set(id, label);
    const name = tile.querySelector("figcaption span");
    if (name) name.textContent = label;
    labelsChanged = true;
  }
  if (labelsChanged) applyScreenLayout();
}

function stopMediaEl(el: HTMLMediaElement | undefined) {
  if (!el) return;
  el.pause();
  el.srcObject = null;
  el.remove();
}

function syncStage() {
  emptyStage.hidden = screensEl.childElementCount > 0;
  applyScreenLayout();
}

function setScreenAudio(peerId: string, stream: MediaStream | null, isSelf: boolean) {
  stopMediaEl(screenAudio.get(peerId));
  screenAudio.delete(peerId);
  if (!stream || isSelf) return;
  const tracks = stream.getAudioTracks();
  if (!tracks.length) return;
  const audio = new Audio();
  audio.autoplay = true;
  audio.srcObject = new MediaStream(tracks);
  void audio.play().catch(() => undefined);
  screenAudio.set(peerId, audio);
  audio.muted = focusedScreenId !== null && focusedScreenId !== peerId;
}

function applyScreenLayout() {
  const ids = [...screenTiles.keys()];
  if (focusedScreenId && !screenTiles.has(focusedScreenId)) {
    focusedScreenId = null;
  }
  if (ids.length < 2) {
    focusedScreenId = null;
    stageBar.hidden = true;
    screensEl.classList.remove("is-focus");
    viewModes.replaceChildren();
  } else {
    stageBar.hidden = false;
    screensEl.classList.toggle("is-focus", focusedScreenId !== null);
    const splitBtn = document.createElement("button");
    splitBtn.type = "button";
    splitBtn.className = `view-mode${focusedScreenId === null ? " active" : ""}`;
    splitBtn.dataset.view = "split";
    splitBtn.textContent = "Dividida";
    const focusBtns = ids.map((id) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `view-mode${focusedScreenId === id ? " active" : ""}`;
      btn.dataset.view = id;
      btn.textContent = screenLabels.get(id) ?? "Tela";
      return btn;
    });
    viewModes.replaceChildren(splitBtn, ...focusBtns);
  }

  for (const [id, tile] of screenTiles) {
    tile.classList.toggle("is-focused", id === focusedScreenId);
    const focusBtn = tile.querySelector<HTMLButtonElement>(".tile-focus");
    if (focusBtn) {
      const many = ids.length > 1;
      focusBtn.hidden = !many;
      focusBtn.textContent =
        focusedScreenId === id ? "Ver todas" : "Ver só esta";
    }
  }

  for (const [id, audio] of screenAudio) {
    audio.muted = focusedScreenId !== null && focusedScreenId !== id;
  }
}

function upsertScreen(peerId: string, stream: MediaStream, label: string, isSelf: boolean) {
  screenLabels.set(peerId, label);
  let tile = screenTiles.get(peerId);
  if (!tile) {
    tile = document.createElement("figure");
    tile.className = "screen-tile";
    tile.dataset.peerId = peerId;
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    const caption = document.createElement("figcaption");
    const name = document.createElement("span");
    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.className = "tile-focus";
    focusBtn.textContent = "Ver só esta";
    caption.append(name, focusBtn);
    tile.append(video, caption);
    screensEl.append(tile);
    screenTiles.set(peerId, tile);
  }
  const video = tile.querySelector("video")!;
  const name = tile.querySelector("figcaption span")!;
  video.srcObject = stream;
  name.textContent = label;
  void video.play().catch(() => undefined);
  setScreenAudio(peerId, stream, isSelf);
  stream.onaddtrack = () => setScreenAudio(peerId, stream, isSelf);
  stream.onremovetrack = () => setScreenAudio(peerId, stream, isSelf);
  syncStage();
}

function removeScreen(peerId: string) {
  const tile = screenTiles.get(peerId);
  if (tile) {
    const video = tile.querySelector("video");
    if (video) video.srcObject = null;
    tile.remove();
    screenTiles.delete(peerId);
  }
  screenLabels.delete(peerId);
  stopMediaEl(screenAudio.get(peerId));
  screenAudio.delete(peerId);
  if (focusedScreenId === peerId) focusedScreenId = null;
  syncStage();
}

function setRemoteAudio(peerId: string, stream: MediaStream | null) {
  stopMediaEl(remoteAudio.get(peerId));
  remoteAudio.delete(peerId);
  if (!stream) return;
  const audio = new Audio();
  audio.autoplay = true;
  audio.srcObject = stream;
  void audio.play().catch(() => undefined);
  remoteAudio.set(peerId, audio);
}

viewModes.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-view]");
  if (!btn) return;
  focusedScreenId = btn.dataset.view === "split" ? null : (btn.dataset.view ?? null);
  applyScreenLayout();
});

screensEl.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".tile-focus");
  if (!btn) return;
  const tile = btn.closest<HTMLElement>(".screen-tile");
  const peerId = tile?.dataset.peerId;
  if (!peerId) return;
  focusedScreenId = focusedScreenId === peerId ? null : peerId;
  applyScreenLayout();
});

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
        upsertScreen(peerId, stream, peerNames.get(peerId) ?? "Alguém", false);
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
        upsertScreen("self", stream, "Você", true);
      },
    });

    gate.hidden = true;
    app.hidden = false;
  } catch (error) {
    const denied =
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
    showError(
      error instanceof TokenError
        ? error.message
        : denied
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
  for (const audio of remoteAudio.values()) stopMediaEl(audio);
  remoteAudio.clear();
  for (const audio of screenAudio.values()) stopMediaEl(audio);
  screenAudio.clear();
  for (const id of [...screenTiles.keys()]) removeScreen(id);
  focusedScreenId = null;
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
