"""
Emote layer — gives each rover a WALL-E-style personality on top of the bare
actuators in rover.py. Pure expression: gaze (camera gimbal = the "head"),
headlight "eyes", body language (micro-drives), and voice. It NEVER touches the
real-time nav loop and every call is wrapped so a missing actuator can't crash
the demo (same "graceful degradation" contract as ROBOTICS.md).

Two personas ship in the box, auto-selected from the ROVER env var
(courier | guard) — same switch roboos_profile.py uses:

    COURIER — eager rookie: chirpy/fast voice, restless curious gimbal, quick
              double-blinks, bounces when happy, visibly droops when rejected.
    GUARD   — gruff veteran: low/slow Texas drawl, still authoritative gaze,
              slow "breathing" eyes that flare bright when suspicious.

Usage:
    from emote import Emoter
    e = Emoter.for_role()          # reads ROVER=courier|guard
    e.start_idle()                 # background "alive" behaviour (optional)
    e.react("greeting")            # composed gesture + lights + voice
    e.gesture("nod_yes")
    ...
    e.stop()

The gimbal frame matches rover.py: gimbal(x, y) where +x pans right, +y tilts
the head UP. Neutral gaze is (0, 0).
"""
import math
import os
import threading
import time
from dataclasses import dataclass, field

try:
    import voice
except Exception:  # voice is optional — silent personas still emote physically
    voice = None


# --------------------------------------------------------------------------
# Persona — the per-agent expressive parameters. Everything that makes two
# robots feel like different *characters* lives here.
# --------------------------------------------------------------------------
@dataclass
class Persona:
    name: str
    voice: str                      # key into voice.VOICES ("robot" | "texas")
    eye_base: int                   # resting headlight PWM (0-255)
    eye_bright: int                 # "alert/excited" PWM
    eye_dim: int                    # "sad/dim" PWM
    breath_period: float            # seconds per eye-breath cycle (idle)
    gaze_range: int                 # how far the idle gaze wanders (deg pan)
    gaze_period: float              # seconds between idle glances
    tempo: float = 1.0              # gesture speed multiplier (<1 = snappier)
    vocalize: bool = True           # speak the little non-verbal beeps?


COURIER = Persona(
    name="Courier",
    voice="robot",
    eye_base=140, eye_bright=255, eye_dim=40,
    breath_period=3.0,
    gaze_range=28, gaze_period=2.2,   # restless — looks around a lot
    tempo=0.8,                        # quick, eager
)

GUARD = Persona(
    name="Guard",
    voice="texas",
    eye_base=110, eye_bright=255, eye_dim=60,
    breath_period=6.0,                # slow, calm breathing
    gaze_range=12, gaze_period=4.0,   # mostly still, deliberate sweeps
    tempo=1.15,                       # slow and authoritative
)

PERSONAS = {"courier": COURIER, "guard": GUARD}


# --------------------------------------------------------------------------
# Emoter — drives a Persona through a Rover. Lazily opens the serial port the
# same way api.py's _live_rover() does, and shares it if you pass one in.
# --------------------------------------------------------------------------
class Emoter:
    def __init__(self, persona: Persona, rover=None):
        self.p = persona
        self._rover = rover
        self._lock = threading.Lock()     # gestures vs. idle loop must not interleave
        self._idle = False
        self._busy = False                # pause idle motion during a gesture
        self._eye = persona.eye_base

    @classmethod
    def for_role(cls, rover=None):
        role = os.environ.get("ROVER", "courier").lower()
        return cls(PERSONAS.get(role, COURIER), rover=rover)

    # --- plumbing ---------------------------------------------------------
    def _r(self):
        if self._rover is None:
            from rover import Rover
            self._rover = Rover()
        return self._rover

    def _safe(self, fn, *a, **k):
        """Run a hardware call; swallow everything — expression never aborts."""
        try:
            fn(*a, **k)
        except Exception as e:
            print(f"emote: {getattr(fn,'__name__','call')} failed: {e}")

    def _t(self, secs):
        time.sleep(secs * self.p.tempo)

    def say(self, text):
        if voice is not None:
            self._safe(voice.say, text, self.p.voice)

    def eyes(self, pwm):
        self._eye = max(0, min(255, int(pwm)))
        self._safe(self._r().lights, self._eye, self._eye)

    def gaze(self, pan, tilt):
        self._safe(self._r().gimbal, pan, tilt)

    def face(self, text, line=0):
        self._safe(self._r().oled, line, text)

    # --- gesture library — composed from primitives, timed for character ---
    def nod_yes(self):
        for _ in range(2):
            self.gaze(0, 25); self._t(0.22)
            self.gaze(0, 5);  self._t(0.22)
        self.gaze(0, 0)

    def shake_no(self):
        for _ in range(2):
            self.gaze(-18, 0); self._t(0.2)
            self.gaze(18, 0);  self._t(0.2)
        self.gaze(0, 0)

    def curious_tilt(self):
        """WALL-E 'huh?' — head cocks up and to the side."""
        self.eyes(self.p.eye_bright)
        self.gaze(0, 18);  self._t(0.35)
        self.gaze(14, 18); self._t(0.5)
        self.gaze(0, 0)

    def perk_up(self):
        """Noticed something — eyes snap bright, head lifts."""
        self.eyes(self.p.eye_bright)
        self.gaze(0, 28); self._t(0.3)
        if self.p.vocalize:
            self.say("eh?")
        self.gaze(0, 0)

    def droop_sad(self):
        """Rejected — eyes dim, head sinks."""
        self.eyes(self.p.eye_dim)
        self.gaze(0, -22); self._t(0.8)
        if self.p.vocalize:
            self.say("aww...")
        self._t(0.6)
        self.gaze(0, 0)

    def suspicious(self):
        """Guard squint — eyes flare, slow side scan."""
        self.eyes(self.p.eye_bright)
        self.gaze(-16, 6); self._t(0.5)
        self.gaze(16, 6);  self._t(0.5)
        self.gaze(0, 0)

    def scan(self):
        """Authoritative sweep of the area."""
        for pan in (-self.p.gaze_range, self.p.gaze_range, 0):
            self.gaze(pan, 8); self._t(0.6)

    def double_take(self):
        self.gaze(20, 0);  self._t(0.18)
        self.gaze(-20, 0); self._t(0.18)
        self.curious_tilt()

    def excited_wiggle(self):
        """Happy body language — quick eye flash + little shimmy."""
        self.eyes(self.p.eye_bright)
        r = self._r()
        for _ in range(3):
            self._safe(r.turn, 0.25); self._t(0.12)
            self._safe(r.turn, -0.25); self._t(0.12)
        self._safe(r.stop)
        if self.p.vocalize:
            self.say("woo-hoo!")
        self.gaze(0, 0)

    def data_pulse(self):
        """GibberLink handshake visual — eyes pulse like a modem talking."""
        for _ in range(4):
            self.eyes(self.p.eye_bright); self._t(0.12)
            self.eyes(self.p.eye_dim);    self._t(0.12)
        self.eyes(self.p.eye_base)

    def blink(self):
        self.eyes(0); self._t(0.1)
        self.eyes(self.p.eye_base)

    GESTURES = (
        "nod_yes", "shake_no", "curious_tilt", "perk_up", "droop_sad",
        "suspicious", "scan", "double_take", "excited_wiggle", "data_pulse",
        "blink",
    )

    def gesture(self, name):
        """Run a named gesture, pausing the idle loop so they don't fight."""
        fn = getattr(self, name, None)
        if not callable(fn) or name not in self.GESTURES:
            print(f"emote: unknown gesture {name!r}")
            return
        self._busy = True
        with self._lock:
            fn()
        self._busy = False

    # --- semantic reactions — map a story event to a full expression -------
    # These are the hooks to drop next to the cp.say(...) beats in show.py /
    # checkpoint.py. Each persona colours the same event differently.
    REACTIONS = {
        "greeting":  {"courier": ("perk_up", None),
                      "guard":   ("scan", None)},
        "handshake": {"courier": ("data_pulse", None),
                      "guard":   ("data_pulse", None)},
        "rejected":  {"courier": ("droop_sad", None),
                      "guard":   ("shake_no", "No valid pass.")},
        "negotiate": {"courier": ("curious_tilt", None),
                      "guard":   ("suspicious", None)},
        "admitted":  {"courier": ("excited_wiggle", None),
                      "guard":   ("nod_yes", "Welcome in.")},
        "thinking":  {"courier": ("curious_tilt", None),
                      "guard":   ("scan", None)},
        "startled":  {"courier": ("double_take", "whoa!"),
                      "guard":   ("perk_up", "Hey now.")},
    }

    def react(self, event):
        role = "guard" if self.p is GUARD else "courier"
        spec = self.REACTIONS.get(event, {}).get(role)
        if not spec:
            return
        gname, line = spec
        self.gesture(gname)
        if line:
            self.say(line)

    # --- idle "alive" loop — never fully still (the Cozmo/Vector trick) -----
    def start_idle(self):
        if self._idle:
            return
        self._idle = True
        threading.Thread(target=self._idle_loop, daemon=True).start()

    def _idle_loop(self):
        t0 = time.time()
        last_glance = 0.0
        while self._idle:
            if self._busy:
                time.sleep(0.1); continue
            now = time.time()
            # breathing eyes — sine between dim and base brightness
            phase = (now - t0) / self.p.breath_period * 2 * math.pi
            lo, hi = self.p.eye_dim, self.p.eye_base
            pwm = lo + (hi - lo) * (0.5 + 0.5 * math.sin(phase))
            with self._lock:
                if not self._busy:
                    self._safe(self._r().lights, int(pwm), int(pwm))
            # occasional wandering glance
            if now - last_glance > self.p.gaze_period:
                last_glance = now
                pan = self.p.gaze_range * math.sin(now * 0.7)
                with self._lock:
                    if not self._busy:
                        self._safe(self._r().gimbal, int(pan), 4)
            time.sleep(0.1)

    def stop(self):
        self._idle = False
        self._t(0.05)
        self.eyes(self.p.eye_base)
        self.gaze(0, 0)


# --------------------------------------------------------------------------
# Manual demo: run each persona through its repertoire (no driving unless you
# pass --wiggle, which spins in place).
#     ROVER=courier python emote.py
#     ROVER=guard   python emote.py
# --------------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    e = Emoter.for_role()
    print(f"Persona: {e.p.name}  (voice={e.p.voice})")
    e.start_idle()
    try:
        for ev in ("greeting", "thinking", "negotiate", "rejected", "admitted"):
            print(f"  react({ev!r})")
            e.react(ev)
            time.sleep(1.5)
    finally:
        e.stop()
        print("done.")
