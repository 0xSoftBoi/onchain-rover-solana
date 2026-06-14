import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type SpeedMode = "low" | "medium" | "high";
type TransportMode = "webrtc" | "ws";

type AuthResponse = {
  token?: string;
  robot?: string;
  driveWs?: string;
  telemetryWs?: string;
  streamUrl?: string;
  stopUrl?: string;
  webrtcOfferUrl?: string;
  error?: string;
};

type TelemetryFrame = {
  ts_ms?: number;
  robot?: string;
  battery_v?: number;
  left_cmd?: number;
  right_cmd?: number;
  deadman_ok?: boolean;
  estop?: boolean;
  stopped_by_deadman?: boolean;
  speed_mode?: SpeedMode;
  max_speed?: number;
  source?: string;
};

type DriveVector = { left: number; right: number };
type StickPosition = { x: number; y: number };
type MutableRef<T> = { current: T };

declare global {
  interface Window {
    __pilotReady?: boolean;
    __pilotDebug?: {
      transport: TransportMode;
      started: boolean;
      dataChannelOpen: boolean;
      wsOpen: boolean;
    };
  }
}

const params = new URLSearchParams(location.search);
const initialRobot = parseRobot(params.get("robot"));
const initialTransport: TransportMode = params.get("transport") === "ws" ? "ws" : "webrtc";
const initialSpeedMode = parseSpeedMode(params.get("speed")) ?? "medium";

function App() {
  const [robot, setRobot] = useState(initialRobot);
  const [transport, setTransport] = useState<TransportMode>(initialTransport);
  const [speedMode, setSpeedMode] = useState<SpeedMode>(initialSpeedMode);
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [controlOpen, setControlOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [dataChannelOpen, setDataChannelOpen] = useState(false);
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [status, setStatus] = useState("tap start");
  const [modalStatus, setModalStatus] = useState("manual control ready");
  const [modalTone, setModalTone] = useState<"" | "ok" | "bad">("");
  const [streamUrl, setStreamUrl] = useState(`/robot/${encodeURIComponent(initialRobot)}/stream`);
  const [videoOk, setVideoOk] = useState(true);
  const [streamRetryCount, setStreamRetryCount] = useState(0);
  const [stick, setStick] = useState<StickPosition>({ x: 0, y: 0 });
  const [readout, setReadout] = useState<DriveVector>({ left: 0, right: 0 });
  const [telemetry, setTelemetry] = useState<TelemetryFrame | null>(null);

  const tokenRef = useRef("");
  const authRef = useRef<AuthResponse | null>(null);
  const speedModeRef = useRef<SpeedMode>(initialSpeedMode);
  const startedRef = useRef(false);
  const controlOpenRef = useRef(false);
  const lastDriveRef = useRef<DriveVector>({ left: 0, right: 0 });
  const sendIntervalRef = useRef<number | undefined>(undefined);
  const streamReconnectTimerRef = useRef<number | undefined>(undefined);
  const streamBaseUrlRef = useRef(`/robot/${encodeURIComponent(initialRobot)}/stream`);
  const streamReconnectAttemptsRef = useRef(0);
  const driveWsRef = useRef<WebSocket | null>(null);
  const telemetryWsRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  const connectionLabel = useMemo(() => {
    if (controlOpen && telemetryOpen) return `${transport} + telemetry`;
    if (controlOpen) return `${transport} control`;
    if (starting) return "connecting";
    return "offline";
  }, [controlOpen, starting, telemetryOpen, transport]);

  const connectionTone = controlOpen ? "up" : starting ? "" : "down";

  const setDebug = useCallback((patch: Partial<NonNullable<typeof window.__pilotDebug>>) => {
    window.__pilotDebug = {
      ...window.__pilotDebug,
      transport,
      started: startedRef.current,
      dataChannelOpen: dataChannelOpen,
      wsOpen: wsOpen,
      ...patch,
    };
  }, [dataChannelOpen, transport, wsOpen]);

  const setControlOpened = useCallback((open: boolean, mode: TransportMode) => {
    controlOpenRef.current = open;
    setControlOpen(open);
    if (mode === "webrtc") {
      setDataChannelOpen(open);
      setDebug({ dataChannelOpen: open });
    } else {
      setWsOpen(open);
      setDebug({ wsOpen: open });
    }
  }, [setDebug]);

  const sendDrive = useCallback((left: number, right: number, force = false) => {
    if (!force && (!startedRef.current || !controlOpenRef.current)) return;
    const body = JSON.stringify({
      left,
      right,
      token: tokenRef.current,
      speed_mode: speedModeRef.current,
      t: Date.now(),
    });
    const dc = dataChannelRef.current;
    const ws = driveWsRef.current;
    if (dc?.readyState === "open") {
      dc.send(body);
    } else if (ws?.readyState === WebSocket.OPEN) {
      ws.send(body);
    }
    setReadout({ left, right });
    setStatus(drivePrompt(left, right));
  }, [transport]);

  const clearDriveLoop = useCallback(() => {
    if (sendIntervalRef.current) window.clearInterval(sendIntervalRef.current);
    sendIntervalRef.current = undefined;
  }, []);

  const startDriveLoop = useCallback(() => {
    clearDriveLoop();
    sendDrive(lastDriveRef.current.left, lastDriveRef.current.right);
    sendIntervalRef.current = window.setInterval(() => {
      sendDrive(lastDriveRef.current.left, lastDriveRef.current.right);
    }, 33);
  }, [clearDriveLoop, sendDrive]);

  const closeControl = useCallback(() => {
    clearDriveLoop();
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    driveWsRef.current?.close();
    driveWsRef.current = null;
    setControlOpened(false, "webrtc");
    setControlOpened(false, "ws");
  }, [clearDriveLoop, setControlOpened]);

  const clearStreamReconnect = useCallback(() => {
    if (streamReconnectTimerRef.current) window.clearTimeout(streamReconnectTimerRef.current);
    streamReconnectTimerRef.current = undefined;
  }, []);

  const setCameraStream = useCallback((url: string) => {
    streamBaseUrlRef.current = url;
    streamReconnectAttemptsRef.current = 0;
    setStreamRetryCount(0);
    clearStreamReconnect();
    setVideoOk(true);
    setStreamUrl(cacheBustUrl(url));
  }, [clearStreamReconnect]);

  const requestStreamReconnect = useCallback(() => {
    setVideoOk(false);
    if (streamReconnectTimerRef.current) return;
    const attempt = streamReconnectAttemptsRef.current + 1;
    streamReconnectAttemptsRef.current = attempt;
    setStreamRetryCount(attempt);
    const delayMs = Math.min(5000, 400 + attempt * 600);
    streamReconnectTimerRef.current = window.setTimeout(() => {
      streamReconnectTimerRef.current = undefined;
      setStreamUrl(cacheBustUrl(streamBaseUrlRef.current));
    }, delayMs);
  }, []);

  const markStreamLoaded = useCallback(() => {
    clearStreamReconnect();
    streamReconnectAttemptsRef.current = 0;
    setStreamRetryCount(0);
    setVideoOk(true);
  }, [clearStreamReconnect]);

  const openTelemetry = useCallback((url?: string) => {
    telemetryWsRef.current?.close();
    if (!url) return;
    const ws = new WebSocket(url);
    telemetryWsRef.current = ws;
    ws.onopen = () => setTelemetryOpen(true);
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as TelemetryFrame;
        setTelemetry(frame);
        if (typeof frame.left_cmd === "number" && typeof frame.right_cmd === "number") {
          setReadout({ left: frame.left_cmd, right: frame.right_cmd });
        }
        if (frame.speed_mode) {
          speedModeRef.current = frame.speed_mode;
          setSpeedMode(frame.speed_mode);
        }
      } catch {
        // Drop malformed telemetry frames.
      }
    };
    ws.onclose = () => setTelemetryOpen(false);
    ws.onerror = () => setTelemetryOpen(false);
  }, []);

  const beginPilot = useCallback(async () => {
    if (starting || startedRef.current) return;
    setStarting(true);
    setModalTone("");
    setModalStatus("opening pilot session");
    try {
      closeControl();
      const auth = await authorize(robot, speedModeRef.current);
      if (!auth.token) throw new Error("authorization missing token");
      tokenRef.current = auth.token;
      authRef.current = auth;
      setRobot(auth.robot || robot);
      setCameraStream(auth.streamUrl || `/robot/${encodeURIComponent(auth.robot || robot)}/stream`);
      openTelemetry(auth.telemetryWs);
      startedRef.current = true;
      setStarted(true);
      setDebug({ started: true });
      setModalStatus(`connecting ${transport}`);
      if (transport === "webrtc") {
        try {
          await openWebrtc(auth, robot, speedModeRef.current, setControlOpened, startDriveLoop, peerRef, dataChannelRef);
        } catch (err) {
          dataChannelRef.current?.close();
          dataChannelRef.current = null;
          peerRef.current?.close();
          peerRef.current = null;
          setControlOpened(false, "webrtc");
          setTransport("ws");
          setModalStatus("webrtc unavailable, connecting ws");
          await openDriveWs(auth, setControlOpened, startDriveLoop, driveWsRef);
        }
      } else {
        await openDriveWs(auth, setControlOpened, startDriveLoop, driveWsRef);
      }
      setModalTone("ok");
      setModalStatus("connected");
      setStatus("hold position");
    } catch (err) {
      startedRef.current = false;
      setStarted(false);
      setDebug({ started: false, dataChannelOpen: false, wsOpen: false });
      setControlOpened(false, "webrtc");
      setControlOpened(false, "ws");
      setModalTone("bad");
      setModalStatus(err instanceof Error ? err.message : "connection failed");
    } finally {
      setStarting(false);
    }
  }, [closeControl, openTelemetry, robot, setCameraStream, setControlOpened, setDebug, startDriveLoop, starting, transport]);

  const stopPilot = useCallback(() => {
    lastDriveRef.current = { left: 0, right: 0 };
    setStick({ x: 0, y: 0 });
    sendDrive(0, 0, true);
    clearDriveLoop();
    startedRef.current = false;
    setStarted(false);
    setDebug({ started: false });
    setStatus("stopped");
    const auth = authRef.current;
    const stopUrl = auth?.stopUrl || `/robot/${encodeURIComponent(robot)}/stop`;
    fetch(stopUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenRef.current }),
    }).catch(() => undefined);
    window.setTimeout(closeControl, 80);
  }, [clearDriveLoop, closeControl, robot, sendDrive, setDebug]);

  const updateDrive = useCallback((value: { fwd: number; turn: number; x: number; y: number }) => {
    const next = {
      left: clamp(value.fwd + value.turn * 0.6, -1, 1),
      right: clamp(value.fwd - value.turn * 0.6, -1, 1),
    };
    lastDriveRef.current = next;
    setStick({ x: value.x, y: value.y });
    sendDrive(next.left, next.right);
  }, [sendDrive]);

  useEffect(() => {
    window.__pilotReady = true;
    window.__pilotDebug = {
      transport,
      started: false,
      dataChannelOpen: false,
      wsOpen: false,
    };
    return () => {
      clearDriveLoop();
      clearStreamReconnect();
      telemetryWsRef.current?.close();
      dataChannelRef.current?.close();
      peerRef.current?.close();
      driveWsRef.current?.close();
    };
  }, [clearDriveLoop, clearStreamReconnect, transport]);

  useEffect(() => {
    setDebug({ started, dataChannelOpen, wsOpen });
  }, [dataChannelOpen, setDebug, started, wsOpen]);

  return (
    <main className="app">
      {!videoOk && <div className="video-fallback">camera reconnecting {streamRetryCount > 0 ? `#${streamRetryCount}` : ""}</div>}
      <img
        className={`video ${videoOk ? "" : "off"}`}
        src={streamUrl}
        alt=""
        onLoad={markStreamLoaded}
        onError={requestStreamReconnect}
      />
      <section className="hud" aria-label="manual pilot">
        <div className="topbar">
          <div className={`chip ${connectionTone}`} id="conn">
            <span className="dot" />
            <span>{connectionLabel}</span>
          </div>
          <div className="chip" id="robotName">/ {robot}</div>
          <div className="chip" id="speedMode">{speedMode}</div>
          <div className="chip" id="battery">{telemetry?.battery_v ? `${telemetry.battery_v.toFixed(2)}V` : "--"}</div>
          <div className="chip" id="deadman">{deadmanLabel(telemetry, started)}</div>
        </div>
        <div className="prompt" id="direction">{status}</div>
        <div className="readout" id="wheelReadout">
          L <span id="left">{readout.left.toFixed(2)}</span> / R <span id="right">{readout.right.toFixed(2)}</span>
        </div>
        <DriveStick
          disabled={!started || !controlOpen}
          position={stick}
          onStart={startDriveLoop}
          onMove={updateDrive}
        />
        <button className="stop" id="estop" type="button" onClick={stopPilot}>STOP</button>
      </section>
      <div className={`modal ${started && controlOpen ? "hidden" : ""}`} id="startModal">
        <div className="modal-panel">
          <h1>Manual Drive</h1>
          <div className={`modal-status ${modalTone}`} id="modalStatus">{modalStatus}</div>
          <button className="start" id="startButton" type="button" disabled={starting} onClick={beginPilot}>
            {starting ? "CONNECTING" : "START"}
          </button>
        </div>
      </div>
    </main>
  );
}

function DriveStick(props: {
  disabled: boolean;
  position: StickPosition;
  onStart: () => void;
  onMove: (value: { fwd: number; turn: number; x: number; y: number }) => void;
}) {
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const mouseActiveRef = useRef(false);

  const move = useCallback((clientX: number, clientY: number) => {
    const zone = zoneRef.current;
    if (!zone) return;
    props.onMove(pointAxes(zone, clientX, clientY));
  }, [props]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (!mouseActiveRef.current) return;
      event.preventDefault();
      move(event.clientX, event.clientY);
    };
    const onMouseUp = (event: MouseEvent) => {
      if (!mouseActiveRef.current) return;
      event.preventDefault();
      mouseActiveRef.current = false;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [move]);

  return (
    <div
      className="stick"
      id="driveZone"
      ref={zoneRef}
      onPointerDown={(event) => {
        if (props.disabled) return;
        event.preventDefault();
        pointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        props.onStart();
        move(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        move(event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        pointerIdRef.current = null;
      }}
      onPointerCancel={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        pointerIdRef.current = null;
      }}
      onMouseDown={(event) => {
        if (props.disabled || pointerIdRef.current !== null) return;
        event.preventDefault();
        mouseActiveRef.current = true;
        props.onStart();
        move(event.clientX, event.clientY);
      }}
    >
      <div
        className="knob"
        style={{
          "--x": `${props.position.x.toFixed(1)}px`,
          "--y": `${props.position.y.toFixed(1)}px`,
        } as React.CSSProperties}
      />
    </div>
  );
}

async function authorize(robot: string, speedMode: SpeedMode): Promise<AuthResponse> {
  const res = await fetch("/pilot/dev-authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ robot, speed_mode: speedMode }),
  });
  const body = await res.json().catch(() => ({})) as AuthResponse;
  if (!res.ok || body.error) throw new Error(body.error || `authorize failed ${res.status}`);
  return normalizeSidecarAuth({
    ...body,
    telemetryWs: body.telemetryWs || (body.driveWs ? deriveTelemetryWs(body.driveWs) : undefined),
  });
}

function normalizeSidecarAuth(auth: AuthResponse): AuthResponse {
  return {
    ...auth,
    driveWs: sameOriginWs(auth.driveWs),
    telemetryWs: sameOriginWs(auth.telemetryWs),
    streamUrl: sameOriginHttp(auth.streamUrl),
    stopUrl: sameOriginHttp(auth.stopUrl),
    webrtcOfferUrl: sameOriginHttp(auth.webrtcOfferUrl),
  };
}

function sameOriginHttp(value?: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value, location.href);
  if (url.pathname.startsWith("/robot/") || url.pathname.startsWith("/pilot/")) {
    return `${url.pathname}${url.search}`;
  }
  return value;
}

function sameOriginWs(value?: string): string | undefined {
  if (!value) return undefined;
  const asHttp = value.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const url = new URL(asHttp, location.href);
  if (!url.pathname.startsWith("/ws/")) return value;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${url.pathname}${url.search}`;
}

async function openWebrtc(
  auth: AuthResponse,
  robot: string,
  speedMode: SpeedMode,
  setControlOpened: (open: boolean, mode: TransportMode) => void,
  startDriveLoop: () => void,
  peerRef: MutableRef<RTCPeerConnection | null>,
  dataChannelRef: MutableRef<RTCDataChannel | null>,
) {
  if (!auth.webrtcOfferUrl) throw new Error("authorization missing WebRTC offer URL");
  const peer = new RTCPeerConnection({ iceServers: [] });
  const channel = peer.createDataChannel("drive", { ordered: false, maxRetransmits: 0 });
  peerRef.current = peer;
  dataChannelRef.current = channel;

  const opened = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("data channel open timeout")), 8000);
    channel.onopen = () => {
      window.clearTimeout(timeout);
      setControlOpened(true, "webrtc");
      startDriveLoop();
      resolve();
    };
    channel.onclose = () => setControlOpened(false, "webrtc");
    channel.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("data channel error"));
    };
  });

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitForLocalIceComplete(peer, 1500);
  const localOffer = peer.localDescription ?? offer;
  const res = await fetch(auth.webrtcOfferUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      robot: auth.robot || robot,
      token: auth.token,
      offer: { type: localOffer.type, sdp: localOffer.sdp },
      speed_mode: speedMode,
    }),
  });
  const body = await res.json().catch(() => ({})) as { answer?: RTCSessionDescriptionInit; error?: string };
  if (!res.ok || body.error || !body.answer) {
    throw new Error(body.error || `webrtc offer failed ${res.status}`);
  }
  await peer.setRemoteDescription(body.answer);
  await opened;
}

async function openDriveWs(
  auth: AuthResponse,
  setControlOpened: (open: boolean, mode: TransportMode) => void,
  startDriveLoop: () => void,
  driveWsRef: MutableRef<WebSocket | null>,
) {
  if (!auth.driveWs) throw new Error("authorization missing drive WebSocket");
  const ws = new WebSocket(auth.driveWs);
  driveWsRef.current = ws;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("drive WebSocket open timeout")), 6000);
    ws.onopen = () => {
      window.clearTimeout(timeout);
      setControlOpened(true, "ws");
      startDriveLoop();
      resolve();
    };
    ws.onclose = () => setControlOpened(false, "ws");
    ws.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("drive WebSocket error"));
    };
  });
}

function parseRobot(value: string | null): string {
  return value === "guard" || value === "courier" ? value : "guard";
}

function parseSpeedMode(value: string | null): SpeedMode | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function deriveTelemetryWs(url: string): string {
  return url.replace(/\/ws\/drive(?:\?.*)?$/, "/ws/telemetry");
}

function cacheBustUrl(value: string): string {
  const url = new URL(value, location.href);
  url.searchParams.set("stream_ts", String(Date.now()));
  return url.toString();
}

async function waitForLocalIceComplete(peer: RTCPeerConnection, timeoutMs: number) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, timeoutMs);
    peer.addEventListener("icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") {
        window.clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function pointAxes(zone: HTMLElement, clientX: number, clientY: number) {
  const rect = zone.getBoundingClientRect();
  const radius = Math.max(1, Math.min(rect.width, rect.height) * 0.42);
  const rawX = clientX - (rect.left + rect.width / 2);
  const rawY = clientY - (rect.top + rect.height / 2);
  const distance = Math.hypot(rawX, rawY);
  const scale = distance > radius ? radius / distance : 1;
  const x = rawX * scale;
  const y = rawY * scale;
  return {
    fwd: clamp(-y / radius, -1, 1),
    turn: clamp(x / radius, -1, 1),
    x,
    y,
  };
}

function drivePrompt(left: number, right: number): string {
  const avg = (left + right) / 2;
  const turn = left - right;
  if (Math.abs(avg) < 0.08 && Math.abs(turn) < 0.08) return "Hold position";
  if (Math.abs(turn) > Math.abs(avg) * 1.3) return turn > 0 ? "Turn right" : "Turn left";
  if (avg < -0.08) return "Reverse";
  return "Drive forward";
}

function deadmanLabel(frame: TelemetryFrame | null, started: boolean): string {
  if (frame?.estop) return "estop";
  if (frame?.stopped_by_deadman) return "stopped";
  if (frame?.deadman_ok) return "ready";
  return started ? "stale" : "idle";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

createRoot(document.getElementById("root")!).render(<App />);
