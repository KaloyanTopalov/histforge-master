# GenAIPro Labs API

Reference for the GenAIPro Voice AI / Labs TTS service. Source: `Labs_API_Documentation.pdf`.

- **Base URL:** `https://genaipro.vn/api`
- **Auth:** `Authorization: Bearer YOUR_SECRET_TOKEN` on every request.
- **Audio host:** the example completed-task `result` URL in the PDF points at `https://media.genaipro.vn/audio/...mp3` (not formally documented as a fixed host).

The flow is async: `POST /v1/labs/task` returns a `task_id`; the audio URL appears on the task object once `status` flips from `processing` to `completed`. Either poll `GET /v1/labs/task/{task_id}` or supply `call_back_url` at create time.

## Endpoints

### 1. Get credits — `GET /v1/labs/credits`

Returns Voice AI credit info for the current user. The response is an array of credit objects.

**200 OK**
```json
[
  {
    "amount": 100000,
    "expire_at": "2026-06-30T23:59:59Z"
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `amount` | number | Credit amount remaining |
| `expire_at` | string (ISO 8601) | Expiration date |

### 2. Create TTS task — `POST /v1/labs/task`

Submit text for synthesis. Returns immediately with a task ID; audio is produced asynchronously.

**Request body** (`application/json`)

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `input` | string | yes | Text to convert to speech |
| `model_id` | enum string | yes | One of `eleven_multilingual_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2_5`, `eleven_v3` |
| `voice_id` | string | yes | Voice ID (from `/v1/labs/voices`) |
| `call_back_url` | string | no | Webhook called when the task completes |
| `similarity` | number | no | 0–1 |
| `speed` | number | no | 0.7–1.2 |
| `stability` | number | no | 0–1 |
| `style` | number | no | Style exaggeration, 0–1 |
| `use_speaker_boost` | boolean | no | Speaker boost toggle |

Omitted optional fields fall back to provider defaults.

**200 OK**
```json
{
  "task_id": "abc123-def456"
}
```

### 3. Task history — `GET /v1/labs/task`

Paginated list of the caller's tasks.

**Query params**

| Name | Type | Description |
|------|------|-------------|
| `page` | integer | Page number |
| `limit` | integer | Tasks per page |

**200 OK**
```json
{
  "tasks": [
    {
      "id": "abc123-def456",
      "input": "Xin chào",
      "voice_id": "21m00Tcm4TlvDq8ikWAM",
      "model_id": "eleven_multilingual_v2",
      "style": 0,
      "speed": 1,
      "use_speaker_boost": true,
      "similarity": 0.5,
      "stability": 0.75,
      "created_at": "2026-03-31T10:00:00Z",
      "status": "completed",
      "result": "https://media.genaipro.vn/audio/abc123.mp3",
      "subtitle": ""
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### 4. Get task — `GET /v1/labs/task/{task_id}`

Returns a single `LabTask` object (same shape as items in the history response).

### 5. Export subtitle — `POST /v1/labs/task/subtitle/{task_id}`

Generate a subtitle file for a completed task. Once exported, the file URL appears on the task's `subtitle` field.

**Body** (`application/json`)

| Name | Type | Description |
|------|------|-------------|
| `max_characters_per_line` | number | Max characters per subtitle line |
| `max_lines_per_cue` | number | Max lines per cue |
| `max_seconds_per_cue` | number | Max duration per cue |

**200 OK** — empty body.

### 6. Delete task — `DELETE /v1/labs/task/{task_id}`

Removes a task. **200 OK** — empty body.

## LabTask object

| Name | Type | Description |
|------|------|-------------|
| `id` | string | Task ID |
| `created_at` | string (ISO 8601) | Creation time |
| `input` | string | Input text |
| `model_id` | string | Model used |
| `voice_id` | string | Voice used |
| `similarity` | number | Similarity value |
| `speed` | number | Speed value |
| `stability` | number | Stability value |
| `style` | number | Style value |
| `use_speaker_boost` | boolean | Whether speaker boost was enabled |
| `status` | enum string | `processing` or `completed` |
| `result` | string | Audio file URL — present once `status = completed` |
| `subtitle` | string | Subtitle file URL — present once exported via endpoint 5 |

## Models

Allowed `model_id` values (enum, per PDF):

- `eleven_multilingual_v2`
- `eleven_turbo_v2_5`
- `eleven_flash_v2_5`
- `eleven_v3`

The PDF lists these as enum values only — no per-model description, latency, or quality info is given. Look up specifics externally before exposing model selection in the UI.

## Integration notes for HistForge

When wiring this up as a TTS provider in `lib/tts/`:

- The provider is **async-only** — there is no synchronous audio response. Either pass `call_back_url` (requires a publicly reachable webhook route) or poll `GET /v1/labs/task/{task_id}` until `status === "completed"` and `result` is populated, then download the MP3 from `result`.
- Polling loops should consume `StepContext.signal` (see memory: long-running step cancellation) so cancels propagate mid-poll.
- `result` is an external URL on `media.genaipro.vn`; download to local disk before passing to alignment/render steps so retries don't refetch over the network.
- `subtitle` is opt-in via endpoint 5
- Voice listing endpoint (`/v1/labs/voices`) is referenced but not documented in the PDF — confirm shape before building voice pickers.
