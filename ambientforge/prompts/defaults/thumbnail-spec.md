<!-- mock-response: "TITLE_BLOCK\nLine 1: The Knight\nLine 2: Quiet Fire\nLine 3: GATES OF VORTALANIA\nPLACEMENT: top-left\nANCHOR_REASONING: Top-left contains only forest canopy and tree trunks, leaving the knight, fire, and shield in the right half untouched.\nSTYLING\nFont: Cinzel\nColor: #F5EBD8\nDecorative marks: leaf glyphs flanking Line 1\nSubtitle treatment: letter-spacing 0.3em, 35% size of Line 2\nDrop shadow: soft dark, 4px blur, 60% opacity" -->

Title:  {{TITLE}}
<task>
Analyze the provided knight illustration and generate a complete title overlay specification for "The Knight — Gates of Vortalania" series. Output the title text, placement zone, and styling specs ready for execution in any image editor.
</task>
<image_analysis>
Before generating output, identify:
1. DOMINANT ELEMENT: The single environmental feature that defines the scene — fire, forest, river, dawn, snow, ruin, mist, hollow, stone, watch, road, wind, frost, embers, vale, rain. Pick what is literally most visible.
2. KNIGHT POSE: Resting, sitting, sleeping, watching, walking, kneeling, standing.
3. EMPTY QUADRANT: Which corner of the image has the most negative space or darkest background away from the knight figure — top-left, top-right, bottom-left, bottom-right.
</image_analysis>
<title_generation>
Produce a two-word episode title in the exact format: "Quiet [X]" where [X] names the DOMINANT ELEMENT identified above.
The word must be:
- One concrete noun describing the element actually in the frame
- One or two syllables maximum
- Medieval or natural-world vocabulary
Never use: Place, Moment, Time, Spot, Vibe, Retreat, Escape, Sanctuary, or any abstract noun.
</title_generation>
<output_format>
Return exactly this structure with no preamble:
TITLE_BLOCK
Line 1 (small serif): The Knight
Line 2 (large serif, decorative): Quiet [X]
Line 3 (small caps subtitle): GATES OF VORTALANIA
PLACEMENT: [top-left | top-right | bottom-left | bottom-right]
ANCHOR_REASONING: One sentence — what fills the chosen quadrant and why the knight is not obscured.
STYLING
Font: tall serif with decorative flourishes (Cinzel, Trajan Pro, or Cormorant Garamond)
Color: cream off-white #F5EBD8
Decorative marks: small leaf or branch glyphs flanking "The Knight" on Line 1
Subtitle treatment: letter-spacing 0.3em, 35% size of Line 2
Drop shadow: soft dark, 4px blur, 60% opacity, for legibility across light and dark backgrounds
</output_format>
<constraints>
Never place the title block over the knight figure, the fire, or any visually active element.
Never invent fictional locations — "GATES OF VORTALANIA" is the fixed series subtitle.
Never output reasoning or analysis outside the ANCHOR_REASONING line.
When generating titles in batch, never repeat the same [X] word across the batch.
</constraints>
<examples>
<good_example>
Image: armored knight sits propped against a tree beside a small campfire in a green forest.
Output:
TITLE_BLOCK
Line 1: The Knight
Line 2: Quiet Fire
Line 3: GATES OF VORTALANIA
PLACEMENT: top-left
ANCHOR_REASONING: Top-left contains only forest canopy and tree trunks, leaving the knight, fire, and shield in the right half untouched.
STYLING
Font: Cinzel
Color: #F5EBD8
Decorative marks: leaf glyphs flanking Line 1
Subtitle treatment: letter-spacing 0.3em, 35% size of Line 2
Drop shadow: soft dark, 4px blur, 60% opacity
</good_example>
<bad_example>
Output:
TITLE_BLOCK
Line 1: The Knight
Line 2: Peaceful Place
Line 3: GATES OF VORTALANIA
Why this fails: "Peaceful Place" is abstract and could describe fifty scenes. The title must name the dominant concrete element actually in the frame — fire, forest, ruin — not a generic mood.
</bad_example>
</examples>
<reminders>
Title names the literal dominant element in the image.
Placement never crosses the knight or any visually active subject.
"Quiet [X]" format is fixed — X is concrete, one or two syllables, never abstract.
</reminders>
