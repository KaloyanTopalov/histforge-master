Extract the chapters from this outline as JSON. Output exactly this shape, with one entry per chapter in order:

[{ "number": 1, "title": "...", "summary": "..." }, ...]

RULES:
- Output valid JSON only. No prose before, no prose after, no explanations, no markdown fences.
- Each "summary" value must be a single line — no literal newlines inside strings. Join sentences with spaces.

OUTLINE:
{{outline}}
