"""
GibberLink — robot-to-robot data-over-sound (ggwave FSK tones), with a network
fallback so the demo never dies to venue noise.

Payloads are small JSON strings (wallet addr, signed challenge, payment confirm).
ggwave caps ~140 bytes/message — keep payloads tight; chunk if needed.
"""
import os
import time

import requests

PEER_URL = os.environ.get("PEER_ROBOT_URL")  # e.g. http://192.168.8.72:8000
FORCE_NETWORK = os.environ.get("GIBBER_NETWORK_ONLY") == "1"

_inbox = []  # network-fallback inbox (api.py can append via /gibber/send)


def _usb_device(kind: str):
    """Pick an audio device. kind: 'input' | 'output'. Overridable via env.

    Jetson gotcha: direct ALSA grab of the USB mic (hw:0/1) fails with
    'Device unavailable' (camera holds it / single-open). The Pulse layer
    mixes fine, so INPUT defaults to 'pulse'. OUTPUT to the USB PnP speaker
    (direct works and is louder) — fall back to default if absent."""
    import sounddevice as sd
    env = os.environ.get(f"GIBBER_{kind.upper()}_DEVICE")
    if env is not None:
        return int(env) if env.isdigit() else env
    if kind == "input":
        for i, d in enumerate(sd.query_devices()):
            if d["name"] == "pulse" and d["max_input_channels"] > 0:
                return i
        return None
    for i, d in enumerate(sd.query_devices()):  # output
        if "USB" in d["name"] and d["max_output_channels"] > 0:
            return i
    return None


def _audio_send(payload: str):
    import ggwave
    import sounddevice as sd
    import numpy as np
    waveform = ggwave.encode(payload, protocolId=1, volume=80)
    audio = np.frombuffer(waveform, dtype=np.float32)
    sd.play(audio, samplerate=48000, blocking=True, device=_usb_device("output"))


def _audio_recv(timeout_secs: float):
    import ggwave
    import sounddevice as sd
    instance = ggwave.init()
    deadline = time.time() + timeout_secs
    try:
        with sd.InputStream(samplerate=48000, channels=1, dtype="float32",
                            blocksize=4096, device=_usb_device("input")) as stream:
            while time.time() < deadline:
                block, _ = stream.read(4096)
                res = ggwave.decode(instance, block.tobytes())
                if res:
                    return res.decode()
    finally:
        ggwave.free(instance)
    return None


def send(payload: str):
    """Chirp the payload; mirror over network as belt-and-braces."""
    if not FORCE_NETWORK:
        try:
            _audio_send(payload)
        except Exception as e:
            print(f"gibber audio send failed ({e}); network fallback only")
    if PEER_URL:  # always mirror — receiver dedupes
        try:
            requests.post(f"{PEER_URL}/gibber/inbox",
                          json={"payload": payload}, timeout=5)
        except Exception:
            pass


def recv(timeout_secs: float = 15):
    """Listen for a chirp; fall back to the network inbox."""
    if not FORCE_NETWORK:
        try:
            got = _audio_recv(timeout_secs)
            if got:
                return got
        except Exception as e:
            print(f"gibber audio recv failed ({e})")
    return _inbox.pop(0) if _inbox else None


def inbox_push(payload: str):
    _inbox.append(payload)
