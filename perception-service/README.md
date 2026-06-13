# perception-service — laptop-hosted VLM (Phase 3)

Runs the heavy vision-language model on the **laptop** (plenty of RAM) so the
Jetson (~2.5 GB shared) never has to. The rover's DimOS agent calls it as
`look` / `locate` / `observe` / `recall` skills; the agent grabs one frame from
the robot's `/stream` and sends it here (robot→laptop only).

## Run (laptop)
```bash
ollama pull moondream                 # or llava — the vision model
VLM_MODEL=moondream python3 vlm_server.py     # serves :4031
```
Point the rover agent at it: `VLM_SERVICE=http://<laptop-ip>:4031`.

## Skills
- `POST /look {image_b64|robot_url, question}` → description/answer
- `POST /locate {..., target}` → `{present, x_frac, confidence}` (feeds seek)
- `POST /observe {..., label}` → describe + store in spatial memory (sqlite)
- `POST /recall {query}` → past observations matching the query

Zero framework deps (stdlib http.server + requests). Spatial memory persists in
`/tmp/rover_spatial_memory.db`. Stub-safe: returns an honest "pull the model"
message until `ollama pull moondream`, so the plumbing runs today.
