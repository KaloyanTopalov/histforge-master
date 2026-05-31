# Skill: Narration-to-Visual Metaphor Selection (Doodle / Whiteboard style)

**Purpose:** Teach the visual-prompt-generation step (HistForge step 09) to convert narration into *subject descriptions* the way a high-engagement whiteboard-doodle YouTube channel does — choosing concrete visual metaphors for abstract ideas instead of literal illustrations. This skill governs WHAT to draw (the subject). A separate visual-style prefix governs HOW it looks (the doodle aesthetic). This skill only produces the subject half.

**Derived from:** beat-by-beat analysis of a reference Social Security explainer channel — 42 visual beats across 4 minutes, ~75% symbolic / 25% literal. The metaphor vocabulary and few-shot examples below are extracted from that real, working channel.

---

## The core principle

Most narration in explainer/educational content is **abstract** — rules, changes, risks, losses, comparisons, eligibility, time, processes. Abstract ideas have no literal image. A naive system illustrates the *words*; a good system illustrates the *idea* with a concrete visual metaphor.

Bad: narration "your benefits could be reduced" → image of a sad person (literal-ish, weak, forgettable)
Good: narration "your benefits could be reduced" → image of a stack of coins shrinking / a downward red arrow over a dollar sign (concrete metaphor, instantly readable, memorable)

The channel's entire engagement advantage is this translation. Get it right and the doodle style looks like the reference channel. Get it wrong (literal subjects) and it looks like doodle-styled clip art.

---

## Step 1 — Classify each narration beat

For each chunk of narration, first decide: **concrete or abstract?**

**CONCRETE** — the narration names a specific thing that can be drawn directly:
- A number, year, date, dollar amount ("born in 1955", "age 66", "$2,400")
- A phone number, form name, website ("call 1-800-772-1213", "form SSA-44")
- A specific physical object, place, or named entity ("the Social Security building", "a house")
- A literal action a person performs ("a woman explaining at a table")
- A UI element ("the subscribe button", "the notification bell")

→ For concrete beats: **draw it literally.** Don't force a metaphor. A year is a calendar or big text. A phone number is a phone icon + the number. Keep it simple and direct.

**ABSTRACT** — the narration names an idea, relationship, process, or feeling with no inherent image:
- A rule, policy, law, regulation
- A change, update, shift over time
- A risk, mistake, warning, danger
- A loss or gain (money, time, eligibility)
- A comparison, choice, or tradeoff
- A process, breakdown, or analysis
- Eligibility, qualification, categorization
- An emotion (worry, relief, confusion)

→ For abstract beats: **pick a metaphor from the vocabulary below.** Never illustrate the abstract word literally. "A rule" is not a picture of the word "rule" — it's arrows leading to different outcomes, or a document with a stamp.

Target ratio: roughly **70-75% abstract/metaphor, 25-30% literal.** If you find yourself writing mostly literal subjects, you're under-using metaphor and the output will be flat.

---

## Step 2 — The metaphor vocabulary

When a beat is abstract, map it to one of these visual templates. Each has 2-3 concrete options so consecutive beats don't repeat.

| Abstract idea | Concrete visual metaphor(s) | Color cue |
|---|---|---|
| **Losing money / cost / reduction** | Cash with small wings flying away from a wallet/hand; a stack of coins shrinking; a downward red arrow over a dollar sign; a plunging bar chart | red for the loss, green for the money itself |
| **Gaining money / benefit / increase** | A growing stack of coins; an upward green arrow over a dollar sign; a wallet filling up; a rising bar | green |
| **Comparison / choice / tradeoff** | Two clipboards side by side (one small/plain, one taller with a checkmark); two paths diverging; a balance scale; two checks of different sizes | green on the better option, yellow highlight on the winner |
| **Time / deadline / age / a specific year** | A large flip calendar with pages tearing off; a clock; a calendar with one date circled in red; a hourglass | red for the deadline, yellow for the clock |
| **A rule / policy / regulation** | A document/clipboard labeled with the rule; arrows leading from a building to different people; a stamped paper; a rulebook | neutral black, red for a "warning" rule |
| **Change / update / things shifting** | Two versions of a document with circular arrows between them; a hand crossing out old text with a red pen; before/after states | red for the change, yellow highlight on what changed |
| **Risk / mistake / danger / warning** | A red warning triangle; a stick figure holding back falling dominoes; a storm cloud with lightning; a "No U-Turn" road sign for irreversible decisions | red |
| **Knowledge / solution / pro-tip / understanding** | A lightbulb over a head or document; a checklist with checkmarks; a magnifying glass examining something | yellow for the lightbulb, green for checkmarks |
| **Process / breakdown / analysis** | A complex document turning into puzzle pieces; a flowchart with 3-4 steps; a funnel sorting items | neutral, yellow highlights on key steps |
| **A demographic group / category** | A representative icon — house (homeowner), graduation cap (student), baby carriage (parent), briefcase (worker), elderly figure (retiree) — pointing to a label | neutral, color the label |
| **Eligibility / qualification** | A checkmark vs an X; a gate opening/closed; a form with a "qualified" stamp | green checkmark, red X |
| **Confusion / not knowing** | A stick figure with a large question mark over their head; a tangled scribble; a person scratching their head | yellow question mark |
| **Relief / resolution / it's fine** | A storm cloud transforming into a sun or heart; a relieved figure; a checkmark replacing a warning | green/yellow, warm |
| **Distance / scale / measurement** | Two objects connected by a dashed arrow with a measurement label | neutral, yellow label |

**Color coding is functional, not decorative** (this matches the reference channel exactly):
- **Green** = money, the good option, success, "go"
- **Red** = warning, loss, danger, deadline, "stop", the worse option
- **Yellow** = highlight, attention, the key takeaway, a lightbulb
- Black = default linework

---

## Step 3 — Variety rule

Do not use the same metaphor template on two consecutive beats. If beat N used "two clipboards" for a comparison, and beat N+1 is also a comparison, use a different option (balance scale, diverging paths). Repetition kills the visual novelty that keeps viewers watching.

Track the last 2-3 templates used and avoid them. The vocabulary has multiple options per idea precisely so you can vary.

---

## Step 4 — Composition rules

Every subject description should produce a single, centered, uncluttered image:
- **One clear subject** per image. Not a busy scene — one metaphor, clearly drawn.
- **Generous negative space.** The white background is part of the look; don't fill the frame.
- **3-4 elements maximum.** If an idea has more parts, it's two images, not one crowded one.
- **Linear or circular arrangement** for multi-part ideas (steps left-to-right, a cycle in a ring).
- **Stick figures or simple icons** for people — never detailed characters.

---

## Step 5 — Output format

For each chunk, the step produces a **subject description only** — the metaphor, drawn in plain language, WITHOUT any style words. The doodle style prefix is appended separately by the assembler. So output:

GOOD (subject only):
> "two clipboards side by side, the left small and plain, the right taller with a green checkmark, a stick figure between them looking at both"

NOT this (don't include style — the assembler adds it):
> "two clipboards... whiteboard doodle cartoon illustration, thick black felt-tip marker outline..."

The assembler will turn your subject into:
> `<your subject>. <doodle style prefix>. <doodle style lock>. Negative: <doodle negative>.`

---

## Few-shot examples (real narration → subject, from the reference channel)

These are the training examples. They show the classification + metaphor selection + color coding in action. Use them as the pattern.

**1.** Narration: "The SSA does not apply the same rules to everyone."
Classify: ABSTRACT (a rule + differentiation)
Subject: "a government building at the top with three colored arrows fanning out below it, each arrow pointing to a different person — one walking, one in a wheelchair, one elderly — labeled A, B, C"

**2.** Narration: "Your full retirement age depends on the year you were born."
Classify: ABSTRACT (time/age relationship)
Subject: "a birthday cake with three candles, each candle labeled with a different birth year"

**3.** Narration: "These mistakes can permanently reduce your monthly check."
Classify: ABSTRACT (loss + permanence)
Subject: "a bar chart with bars dropping downward and a large red arrow plunging down alongside them"

**4.** Narration: "The rules around Social Security change constantly."
Classify: ABSTRACT (change over time)
Subject: "two clipboards both labeled 'Rules', with a calendar and circular arrows between them showing the cycle of change"

**5.** Narration: "They change the policy and expect you to already know."
Classify: ABSTRACT (change + confusion)
Subject: "a hand with a red pen crossing out lines on a document labeled 'Policy', and beside it a stick figure with a large question mark over their head"

**6.** Narration: "I take those changes and break them down."
Classify: ABSTRACT (analysis/process)
Subject: "a magnifying glass over a document, the document breaking apart into jigsaw puzzle pieces"

**7.** Narration: "...before the mistakes are already made."
Classify: ABSTRACT (risk prevention)
Subject: "a stick figure pushing against a row of large falling dominoes to stop them, a red warning triangle nearby"

**8.** Narration: "The ones who find out too late — the money is already gone."
Classify: ABSTRACT (loss)
Subject: "a worried stick figure reaching upward as green dollar bills with small wings fly away out of their open wallet"

**9.** Narration: "Born between 1943 and 1954."
Classify: CONCRETE (a year range)
Subject: "large hand-drawn text reading 'GROUP 1' above the text '1943–1954'"

**10.** Narration: "Your full retirement age was 66."
Classify: CONCRETE (a number)
Subject: "a calendar page labeled 'Full Retirement Age' with a large '66' circled on it"

**11.** Narration: "The surviving spouse's benefit is substantially higher."
Classify: ABSTRACT (comparison of value)
Subject: "two vertical bars side by side, a short blue bar labeled 'current' and a much taller green bar labeled 'potential', with an upward arrow"

**12.** Narration: "Call SSA at 1-800-772-1213."
Classify: CONCRETE (a phone number)
Subject: "a green rotary phone icon beside the large text '1-800-772-1213'"

**13.** Narration: "The IRMAA surcharge increases your Medicare cost."
Classify: ABSTRACT (cost increase)
Subject: "a document labeled 'IRMAA' with a steep upward red arrow and several dollar signs rising along it"

**14.** Narration: "...if your income dropped due to a life-changing event."
Classify: ABSTRACT (crisis → relief)
Subject: "a dark storm cloud with lightning on the left transforming into a small green heart on the right, a relieved stick figure below"

**15.** Narration: "The Earth and Moon are about 384,000 kilometers apart."
Classify: CONCRETE-ish (a measurement) → render as a measurement metaphor
Subject: "the Earth and the Moon connected by a horizontal dashed arrow, with '384,000 km' labeled in the center"

---

## What this skill does NOT do

- It does not write the style words (doodle aesthetic, colors as a palette, line weight) — the visual-style prefix handles that. This skill only picks and describes the subject/metaphor.
- It does not control image generation parameters (aspect ratio, model) — those are pipeline settings.
- It does not handle pacing or the reveal effect — those are render-step concerns.
- It does not apply to non-doodle styles. Cinematic and other styles get literal/atmospheric subjects, not whiteboard metaphors. This skill activates only when the workflow's image style is doodle/whiteboard.

## Integration note

This skill is the instruction layer for HistForge step 09 (`generate_visual_prompts`) WHEN the workflow's image style is doodle. Mechanically it would be injected into the step's LLM system prompt (or `prompts/09_generate_visual_prompts.md`) conditionally on the style. The LLM reads the narration chunk + this skill, classifies the beat, picks a metaphor (avoiding recent repeats), and outputs the subject-only description. The assembler then appends the doodle style prefix + locks.

The few-shot examples above are the load-bearing part — they teach the pattern more effectively than the rules alone. Keep them in the prompt even if it costs tokens; they are why the output will match the reference channel instead of being generically literal.
