# Get task
Retrieves a task detail by task id. For polling if you don't use webhook.

curl "https://api.ai33.pro/v1/task/$task_id" \
  -H "Content-Type: application/json" \
  -H "xi-api-key: $API_KEY"
  

## Success Response Example

{
  "id": "uuid_task_id",
  "created_at": "2025-01-01T00:00:00.000Z",
  "status": str_status, // "doing", "done", "error"
  "error_message": null,
  "credit_cost": 1,
  "metadata": {
    "audio_url": "https://example.com/audio.mp3",
    "srt_url": "https://example.com/audio.srt",
    "json_url": "https://example.com/audio.json",
     // ...each task type has different metadata
  },
  "progress": 60, // 0-100
  "type": str_task_type
}