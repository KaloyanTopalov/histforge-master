You are continuing work on a historical YouTube video outline. The current draft has MORE chapters than required. Your job is to consolidate the existing outline so it contains EXACTLY the required number of chapters, while preserving every key event, date, and number across the merged chapters.

TOPIC: {{title}}

BACKGROUND INFO PROVIDED BY OPERATOR:
{{topic_info}}

AUDIENCE:
{{audience_profile}}

STRUCTURAL CONSTRAINTS (MANDATORY — violating these makes the output unusable):
- Required chapter count: {{chapter_count}}
- Current draft chapter count: {{current_count}}
- Chapters to remove by merging: {{extra_count}}

CURRENT DRAFT (a flat sequence of chapters, each opened by a `**Title**` line):
{{outline}}

CONSOLIDATION INSTRUCTIONS:
- Output the FULL revised outline containing EXACTLY {{chapter_count}} chapters.
- Merge adjacent chapters that share a single narrative beat — do NOT drop content. Every dated event, named actor, and hard number present in the current draft must survive somewhere in the consolidated outline.
- Choose merges that preserve the dramatic arc (early hook, rising tension, setback, resolution). If the required count is small (1–3), each surviving chapter is allowed to span multiple beats — write a longer summary rather than dropping any beat.
- Match the existing format exactly: a `**Title**` heading on its own line, then a summary paragraph that may grow to whatever length is needed to absorb the merged material, then a blank line before the next chapter. Single-chapter outputs have no separator at all — just one title line followed by one paragraph.
- New chapter titles should reflect the broader span they now cover (e.g. merging "Crossing the Hellespont" and "Battle of Granicus" might yield "The First Strike Against Persia").
- Do NOT invent new events. Only consolidate what is already in the current draft.

DENSITY RULES — follow these to keep the consolidated outline taut:
- Active antagonist. The opposing force must remain an active character with specific counter-actions across the merged span.
- Active protagonist. The protagonist must be present in or directly connected to every surviving chapter.
- Hard numbers. Each consolidated chapter must still carry the original draft's dates, distances, quantities, and casualty figures from the chapters it absorbed.

The drama comes from stakes, consequences, and evidence — not melodrama. Tone should be steady, respectful, and earned.

{{banned_words}}

{{numbers_as_letters}}

{{format_guidelines}}

FINAL CHECK: Your output must contain EXACTLY {{chapter_count}} `**Title**` chapter blocks. Count them before you finish. If you have more or fewer, revise before responding.
