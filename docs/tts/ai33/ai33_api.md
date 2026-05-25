#Create Speech
Converts text into speech using a voice of your choice and returns audio.

## Request

curl -X POST "https://api.ai33.pro/v1/text-to-speech/$voice_id?output_format=mp3_44100_128" \
  -H "Content-Type: application/json" \
  -H "xi-api-key: $API_KEY" \
  -d '{
  "text": "The first move is what sets everything in motion.",
  "model_id": "eleven_multilingual_v2",
  "with_transcript": false, // Optional, if you want to get the transcript of the audio
  "receive_url": "http://your-webhook-endpoint" // Optional, if you want to receive the audio file via webhook.
}'


## Success Response Example

{
  "success": true,
  "task_id": uuid_task_id,
  "ec_remain_credits": int_credits_remain
}


## Request we POST to your webhook endpoint; or you can polling the Common / GET Task

{
  "id": "uuid_task_id",
  "created_at": "2025-01-01T00:00:00.000Z",
  "status": "done",
  "error_message": null,
  "credit_cost": 1,
  "metadata": {
    "audio_url": "https://example.com/audio.mp3",
    "srt_url": "https://example.com/audio.srt",
    "json_url": "https://example.com/audio.json",
    // ...each task type has different metadata
  },
  "type": "tts"
}


Read Elevenlabs documentation for details -> https://elevenlabs.io/docs/api-reference/text-to-speech/convert