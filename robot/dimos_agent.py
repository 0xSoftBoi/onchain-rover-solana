"""
DimOS Phase 2 — the rover's brain: an Ollama agent whose SKILLS are our own
services. The agent reasons in natural language and calls real tools:

  drive / seek / capture / say  -> robot FastAPI (:8000)
  store_proof (Walrus)          -> robot FastAPI
  hire / give_feedback / verify -> sidecar crypto rails (:4021, x402 on Arc)

So "a buyer hired us to photograph booth 12" makes the agent: seek -> capture ->
store proof on Walrus -> write ERC-8004 feedback — a genuine tool-calling loop
over physical + on-chain skills (the honest answer to "is it really an agent?").

Skill LOGIC is plain functions (skills.* below) so it's testable without DimOS;
build_skills()/build_agent() wrap them as DimOS Skills + an Ollama agent lazily.

Run on the Jetson (DimOS installed):  python dimos_agent.py "<task>"
"""
import os

import requests

ROBOT_API = os.environ.get("ROBOT_API", "http://localhost:8000")
SIDECAR = os.environ.get("SIDECAR_URL", "http://localhost:4021")
ROVER = os.environ.get("ROVER", "courier")
MODEL = os.environ.get("AGENT_MODEL", "ollama:gemma3:1b")

_S = requests.Session()


def _post(base, path, body=None, timeout=120):
    try:
        r = _S.post(f"{base}{path}", json=body or {}, timeout=timeout)
        try:
            return r.json()
        except ValueError:
            return {"status": r.status_code, "raw": r.text[:160]}
    except Exception as e:
        return {"error": str(e)[:160]}


def _get(base, path, params=None, timeout=30):
    try:
        return _S.get(f"{base}{path}", params=params, timeout=timeout).json()
    except Exception as e:
        return {"error": str(e)[:160]}


# --- skill logic (plain, testable) -----------------------------------------
class skills:
    @staticmethod
    def drive(linear: float, angular: float):
        """Move the rover: linear m/s (forward+), angular rad/s (left+)."""
        import dimos_rover
        left, right = dimos_rover.twist_to_wheels(linear, angular)
        return _post(ROBOT_API, "/drive", {"left": left, "right": right}, timeout=5)

    @staticmethod
    def seek(target: str):
        """Vision-seek a target (open-vocab or 'tag:<id>') and drive to it."""
        return _post(ROBOT_API, "/seek", {"target": target, "timeout_secs": 45}, timeout=60)

    @staticmethod
    def say(text: str):
        """Speak a line aloud."""
        return _post(ROBOT_API, "/say", {"text": text}, timeout=20)

    @staticmethod
    def capture():
        """Take the proof photo. Returns {photo, sha256}."""
        return _post(ROBOT_API, "/capture", timeout=30)

    @staticmethod
    def store_proof():
        """Store the latest photo on Walrus. Returns {blobId, sha256}."""
        return _post(ROBOT_API, "/store-proof", timeout=120)

    @staticmethod
    def hire(task: str, rover: str = ROVER):
        """Hire a rover for a job over x402 (paid). Returns payment + result."""
        return _post(SIDECAR, f"/task/{rover}", {"task": task}, timeout=120)

    @staticmethod
    def give_feedback(score: int, skill: str = "deliver",
                      blobId: str = "", sha256: str = ""):
        """Write an ERC-8004 reputation record for the completed job."""
        return _post(SIDECAR, "/give-feedback",
                     {"robot": ROVER, "skill": skill, "score": score,
                      "blobId": blobId, "sha256": sha256}, timeout=120)

    @staticmethod
    def verify_agent(wallet: str, agentId: str = ""):
        """Verify an agent on-chain (AgentBook + ERC-8004 + pass)."""
        return _post(SIDECAR, "/verify-agent", {"wallet": wallet, "agentId": agentId})


SKILL_CATALOG = [
    ("drive", skills.drive, "move(linear m/s, angular rad/s)"),
    ("seek", skills.seek, "vision-seek + approach a target"),
    ("say", skills.say, "speak a line"),
    ("capture", skills.capture, "take the proof photo"),
    ("store_proof", skills.store_proof, "anchor the photo on Walrus"),
    ("hire", skills.hire, "hire a rover over x402"),
    ("give_feedback", skills.give_feedback, "write ERC-8004 reputation"),
    ("verify_agent", skills.verify_agent, "verify an agent on-chain"),
]

SYSTEM_PROMPT = (
    "You are the brain of a physical rover that is a hireable on-chain agent. "
    "You have skills to move (drive/seek), perceive (capture), speak (say), "
    "anchor proof on Walrus (store_proof), and touch the crypto rails (hire, "
    "give_feedback, verify_agent). Complete the user's job by calling skills, "
    "then ALWAYS capture + store_proof so the work is provable, and "
    "give_feedback to record reputation. Keep moves small and safe."
)


# --- DimOS wrappers (lazy; only needed on the Jetson) ----------------------
def build_skills():
    """Wrap the plain skill functions as DimOS Skills (Pydantic tool models)."""
    from dimos.skills.skill_library import SkillLibrary, AbstractSkill
    from pydantic import Field

    lib = SkillLibrary()

    class Drive(AbstractSkill):
        """Move the rover. linear: m/s forward (+). angular: rad/s left (+)."""
        linear: float = Field(..., description="forward m/s, ~-0.35..0.35")
        angular: float = Field(0.0, description="turn rad/s, left positive")
        def __call__(self): return skills.drive(self.linear, self.angular)

    class Seek(AbstractSkill):
        """Vision-seek and approach a target (open-vocab or 'tag:<id>')."""
        target: str = Field(..., description="what to find, e.g. 'red lanyard' or 'tag:0'")
        def __call__(self): return skills.seek(self.target)

    class Say(AbstractSkill):
        """Speak a short line aloud."""
        text: str = Field(...)
        def __call__(self): return skills.say(self.text)

    class Capture(AbstractSkill):
        """Take the proof photo."""
        def __call__(self): return skills.capture()

    class StoreProof(AbstractSkill):
        """Anchor the latest photo on Walrus (decentralized proof)."""
        def __call__(self): return skills.store_proof()

    class GiveFeedback(AbstractSkill):
        """Write an ERC-8004 reputation record for the job."""
        score: int = Field(95, description="0-100 quality score")
        blobId: str = Field("", description="Walrus blobId of the proof")
        sha256: str = Field("", description="photo sha256")
        def __call__(self): return skills.give_feedback(self.score, "deliver", self.blobId, self.sha256)

    for s in (Drive, Seek, Say, Capture, StoreProof, GiveFeedback):
        lib.add(s)
    return lib


def build_agent():
    """Build the Ollama-backed DimOS agent wired to the skills above."""
    from dimos.agents.vlm_agent import VLMAgent, VLMAgentConfig
    return VLMAgent(VLMAgentConfig(
        model=MODEL, skills=build_skills(), system_prompt=SYSTEM_PROMPT))


if __name__ == "__main__":
    import sys
    task = " ".join(sys.argv[1:]) or "photograph the checkpoint and prove it"
    agent = build_agent()
    print(agent.run(task))
