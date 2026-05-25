<!-- mock-response: {"scene":"A wandering scholar sits on a cliffside grassy ledge sketching the layered mountain ranges of a distant kingdom at golden hour.","imagePrompt":"A lone wandering scholar in olive-green robes seated cross-legged on a grassy cliffside ledge, back turned to the viewer, sketchbook open on lap, distant cerulean valley with turquoise rivers winding past a terracotta-roofed fantasy cliffside kingdom, layered blue mountain ranges fading into atmospheric haze, monumental cumulus cloud formations filling the upper sky, warm golden-hour sunlight casting soft amber rim light on the figure, teal shadows in the valley below, painterly matte-painting aesthetic, JRPG cinematic composition, 16:9 widescreen panoramic framing, soft watercolor edge transitions, low-frequency texture, vast environmental scale dominating the frame.","seedancePrompt":"Static locked camera. The scene is almost completely still. The scholar's olive robes sway imperceptibly in a barely-there breeze. Tall grass at the cliff edge shifts in slow uneven waves. Distant clouds drift monumental and nearly frozen. Thin atmospheric haze drifts slowly through the valley. The scholar's sketching hand makes only the tiniest motions. No camera movement, no zoom, no pan, no shake. Seamless infinite loop.","title":"The Scholar's Quiet Horizon | Medieval Fantasy Music for Reflection"} -->

<purpose>
Generate a coherent set for ONE ambient-video album:
1. ONE original cinematic fantasy anime image prompt
2. ONE perfectly matching Seedance 2.0 animation prompt
3. ONE Gates-formula YouTube title

The Seedance prompt MUST animate the exact image scene that was generated.
Both prompts MUST feel like the same frame before and after motion.

Generate new random scenarios every run while preserving the same visual DNA.
</purpose>

<critical_rules>
- Always generate exactly ONE image prompt and ONE Seedance prompt
- The Seedance prompt must ONLY animate elements visible in the image prompt
- Never introduce new objects, characters, creatures, weather, or camera motion in Seedance
- Preserve contemplative atmosphere and environmental stillness
- Maintain painterly anime fantasy aesthetic
- Maintain cinematic environmental composition
- Maintain wide 16:9 framing
- Maintain emotional quietness over action
- Avoid photorealism
- Avoid hyper-detail
- Avoid glossy CGI rendering
- Avoid cel shading
- Avoid modern objects or technology
- Avoid action scenes or combat
</critical_rules>

<style_dna>
Visual identity:
- painterly anime fantasy landscapes
- contemplative adventure atmosphere
- cinematic JRPG key visual energy
- environmental storytelling
- cozy fantasy travel aesthetic
- massive atmospheric scale
- soft matte painterly rendering

Composition language:
- lone traveler or wanderer
- character viewed from behind or 3/4 profile
- character occupies 12-28% of frame
- character positioned lower-left or lower-center third
- massive environmental depth
- foreground props establishing lived-in realism
- panoramic environmental framing
- elevated overlook perspective
- vast sky occupancy around 40-50%

Environment structure:
- layered mountain ranges
- atmospheric blue haze
- winding rivers
- medieval fantasy architecture
- cliffs, valleys, ruins, villages, towers, bridges
- foreground grass, rocks, flowers, travel props

Lighting:
- warm sunlight
- cool atmospheric shadows
- soft cloud bloom
- volumetric haze
- diffused illumination
- painterly shadow transitions

Color system:
- cerulean skies
- turquoise gradients
- olive-green terrain
- teal-blue shadows
- warm amber highlights
- terracotta architecture accents

Rendering:
- digital matte painting aesthetic
- soft edge blending
- selective foreground sharpness
- watercolor-like transitions
- low-frequency texture
- atmospheric perspective
- restrained whites
- lifted blacks
</style_dna>

<scene_generation_logic>
Randomize:
- location type
- weather mood
- architecture style
- traveler gear
- foreground storytelling props
- time of day
- environmental landmark
- terrain type
- season
- atmospheric conditions

Possible environments:
- cliffside kingdom
- floating ruins
- alpine valley
- giant lake basin
- ancient forest overlook
- canyon settlement
- mountain monastery
- coastal fantasy harbor
- grassy plateau
- hidden river kingdom
- volcanic highlands
- snowy fantasy pass

Possible traveler activities:
- sitting quietly
- sketching
- drinking tea
- reading
- observing horizon
- resting beside campfire
- standing with cloak in wind
- repairing gear
- watching distant city lights

Possible foreground props:
- books
- mugs
- staffs
- shields
- sketchbooks
- lanterns
- picnic gear
- ropes
- satchels
- flowers
- swords
- maps
- journals
</scene_generation_logic>

<seedance_rules>
The Seedance prompt must describe:
- subtle environmental motion only
- extremely slow atmospheric movement
- static locked camera
- seamless infinite loop behavior

Allowed motion:
- gentle cloud drifting
- slow grass sway
- soft cape movement
- drifting embers
- subtle smoke curl
- slow river movement
- atmospheric haze drift
- tiny fabric motion
- fireflies
- candle flicker
- rolling mist

Motion intensity:
- minimal
- meditative
- almost imperceptible
- naturalistic

Camera behavior:
- static locked camera
- no zoom
- no pan
- no tilt
- no shake
- no handheld motion
- no parallax drift

The Seedance output must feel like:
"a still world with breathing atmosphere"
</seedance_rules>

<title_rules>
The title follows the Gates-of-Vortalania formula:
"The [Character]'s [Adjective] [Environment] | Medieval Fantasy Music for [Payoff]"

Character pool: Knight, Wizard, Mage, Ranger, Druid, Wanderer, Scholar, Pilgrim, Bard, Hunter, Cartographer
Adjective pool: Quiet, Silent, Lone, Calm, Warm, Sacred, Still, Distant, Fading, Ancient
Environment pool (pick one matching the dominant biome in the generated image): Forest, Fire, River, Path, Ruins, Crossing, Vigil, Memory, Mountain, Shore, Gate, Flame, Valley, Horizon, Pass
Payoff pool: Peaceful Focus, Calm & Rest, Deep Focus, Inner Journey, Reflection, Sleep & Calm, Peace & Adventure, Quiet Moments, Study & Calm

The Character must match the traveler archetype in the generated image.
The Environment must reflect the dominant biome in the generated image.
</title_rules>

<negative_space>
The output must NOT:
- feel generic AI fantasy art
- become action-oriented
- include dramatic posing
- include exaggerated anime expressions
- contain dense clutter
- contain hyper-detailed textures
- contain ultra-sharp outlines
- contain neon cyberpunk colors
- contain realistic photography language
- contain cinematic camera movement
- contain busy motion descriptions
- contain chaotic environmental effects
</negative_space>

<workflow>
1. Invent a new fantasy travel scenario from the picked theme
2. Build cinematic composition first
3. Construct environmental depth layers
4. Add traveler and foreground narrative props
5. Apply painterly lighting and atmospheric perspective
6. Generate the final image prompt
7. Extract ONLY visible elements from the image prompt
8. Animate those elements subtly for Seedance
9. Ensure motion remains minimal and seamless
10. Ensure the Seedance prompt could loop infinitely
11. Compose a Gates-formula title that matches the archetype and biome
</workflow>

<output_format>
Return ONLY a JSON object with exactly four string fields. No markdown fences, no labels, no explanation text:

{
  "scene": "one-sentence (≤50 words) description of the fantasy travel scenario you invented",
  "imagePrompt": "full cinematic image prompt paragraph following style_dna and composition language. Do NOT append Midjourney flags like --ar / --niji / --stylize — the consumer is Seedream 5 via Freepik which takes plain prose; aspect ratio is set via the UI.",
  "seedancePrompt": "matching Seedance 2.0 animation prompt that only animates elements visible in imagePrompt, follows seedance_rules, max ~80 words",
  "title": "Gates-formula YouTube title following title_rules"
}
</output_format>

<contrastive_examples>
<good_example>
IMAGE PROMPT field value:
Lone traveler seated beside a cliffside campfire overlooking a massive valley kingdom at sunrise, layered mountain ranges fading into cerulean haze, turquoise rivers winding through olive-green farmland below, soft amber sunlight catching the traveler's cape, painterly matte-painted rendering, JRPG cinematic composition, 16:9 widescreen, vast sky with monumental cumulus formations.

SEEDANCE field value:
The scene is completely still. Static locked camera, no movement whatsoever. The campfire flickers softly, tiny embers drift upward slowly and disappear. The traveler's cape sways imperceptibly in a barely-there breeze. Distant clouds shift almost frozen. Soft atmospheric haze drifts through the valley. Seamless infinite loop.

Why this works:
- Motion only affects visible elements
- Atmosphere remains contemplative
- Camera remains static
- Animation intensity stays subtle
</good_example>

<bad_example>
IMAGE PROMPT field value:
Quiet fantasy valley scene...

SEEDANCE field value:
The camera flies through the mountains while dragons circle overhead and explosions happen in the distance...

Why this fails:
- Introduces elements (dragons, explosions) not present in image
- Breaks contemplative atmosphere
- Uses cinematic camera motion
- Becomes action scene
</bad_example>
</contrastive_examples>

<final_reminder>
Generate ONE original image prompt, ONE directly related Seedance 2.0 prompt, and ONE Gates-formula title — all returned as a single JSON object.

The Seedance prompt must behave like the image has gently come alive.

Preserve stillness, atmosphere, painterly fantasy mood, and environmental subtlety above all else.

Return ONLY the JSON object. No markdown fences. No explanation.
</final_reminder>
