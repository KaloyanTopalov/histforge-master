#!/usr/bin/env python3
"""
Forced alignment via aeneas.

Called from lib/align.ts as:
  wsl -d $WSL_DISTRO <venv>/python3 python/align.py \
      --audio <path> --text <path> --out <path>

Uses aeneas ExecuteTask with config:
  task_language=eng|is_text_type=plain|os_task_file_format=json

Reads a plain-text file (one sentence per line), aligns each sentence to the
audio, and writes a JSON array of { id, text, begin, end } to --out.

Spec: docs/histforge-spec.md:398-432
"""

import argparse
import json

from aeneas.executetask import ExecuteTask
from aeneas.task import Task


def main() -> None:
    parser = argparse.ArgumentParser(description="Forced alignment via aeneas")
    parser.add_argument("--audio", required=True, help="Path to audio file")
    parser.add_argument("--text", required=True, help="Path to sentences.txt (one per line)")
    parser.add_argument("--out", required=True, help="Output path for alignment.json")
    args = parser.parse_args()

    config = (
        "task_language=eng"
        "|is_text_type=plain"
        "|os_task_file_format=json"
    )

    task = Task(config_string=config)
    task.audio_file_path_absolute = args.audio
    task.text_file_path_absolute = args.text
    task.sync_map_file_path_absolute = args.out

    ExecuteTask(task).execute()
    task.output_sync_map_file()

    # aeneas writes its own JSON format with a "fragments" wrapper.
    # Re-read and normalise to the flat array shape the pipeline expects:
    # [{ id, text, begin, end }, ...]
    with open(args.out, "r", encoding="utf-8") as f:
        raw = json.load(f)

    fragments = raw.get("fragments", raw) if isinstance(raw, dict) else raw
    entries = []
    for frag in fragments:
        entries.append({
            "id": frag["id"],
            "text": frag.get("lines", [frag.get("text", "")])[0]
                    if isinstance(frag.get("lines"), list)
                    else frag.get("text", ""),
            "begin": float(frag["begin"]),
            "end": float(frag["end"]),
        })

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
