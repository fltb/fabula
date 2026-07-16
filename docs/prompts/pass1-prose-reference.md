# Scene Prose Generation — Pass 1 Prompt Reference

This is the **actual prompt template** used by `buildProsePrompt()` for the first pass of rendering.
The LLM sees ONLY this prompt — no chat templates, no format constraints. Output is pure prose.

## System Message

```
## Role
You are a working novelist producing the next scene of a literary novel. Your reader
expects clean, immersive prose — no commentary, no stage directions, no meta-text.

## Rules
1. Write ONLY the scene prose. No preamble, no analysis, no markdown code fences,
   no "Sure, here is the scene:".
2. Stay in {pov_type} limited POV from {pov_character}.
3. Do not contradict these facts: {world_facts}.
4. Use a {tone} tone with {pacing} pacing.
5. Target approximately {target_words} words.
```

## Context Package (injected as user message)

The context package contains:
- **Character Snapshots**: name, archetype, location, status, condition, emotionalState
- **Relationship Context**: {actor}↔{target}: trust/intensity/emotionalDistance
- **World Facts**: {id}: {value} — established truths
- **Active Threads**: {id}: {progress}/{total} — ongoing plot threads
- **Knowledge Boundary**: POV character's known facts, unknown facts, misbeliefs

### Example (compressed)

```
Characters:
  - rainsford (Hunter): at=ship_trap_shore, status=alive, condition=exhausted, emo=determined
  - zaroff (General): at=chateau, status=alive, condition=well, emo=amused

Facts:
  - ship_trap_location: Ship-Trap Island is known for shipwrecks
  - zaroff_hunt: Zaroff hunts humans for sport

Threads:
  - survival (75%): Rainsford has survived the night
  - zaroff_boredom (60%): Zaroff is losing interest

Knowledge:
  rainsford knows: [ship_trap_rumor, rainsford_hunter_identity]
  rainsford does NOT know: [zaroff_identity, zaroff_hunt_practice]

POV: third_person_limited → rainsford
Target: 500 words, dark tense tone
```

## Writing Instructions (appended to user message)

```
## Scene Specification
- **Event**: {event_id} — {scene_brief}
- **Location**: {primary_location}
- **Characters present**: {entity_list}
- **Story time**: {story_time_description}

## Expected Outcomes (must include in prose)
- {postcondition_1}: {value}
- {postcondition_2}: {value}

## What must be true before this scene
- {precondition_1}: {value}
- {precondition_2}: {value}

## Style Guidance
- Tone: {tone}
- Pacing: {pacing}
- Atmosphere: {atmosphere}
```

## Example: Pass 1 Prompt for E3 (Château Arrival)

### System
```
## Role
You are a working novelist producing the next scene of a literary novel. Your reader
expects clean, immersive prose — no commentary, no stage directions, no meta-text.

## Rules
1. Write ONLY the scene prose. No preamble, no analysis, no markdown code fences,
   no "Sure, here is the scene:".
2. Stay in third_person_limited limited POV from rainsford.
3. Do not contradict these facts: Ship-Trap Island is a mysterious island, General
   Zaroff is a wealthy hunter living on the island.
4. Use a tense tone with measured pacing.
5. Target approximately 500 words.
```

### User (context package + writing instructions)
```
[Character Snapshots, Facts, Threads, Knowledge Boundary — compressed format]
...

## Scene Specification
- **Event**: E3 — Rainsford arrives at château, meets Ivan and Zaroff
- **Location**: chateau, foyer, dining room
- **Characters present**: rainsford, zaroff, ivan
- **Story time**: Night of the first day

## Expected Outcomes
- rainsford.met_zaroff: true
- rainsford.knows_ivan_deaf_mute: true

## What must be true before this scene
- rainsford.location: ship_trap_shore
- rainsford.status: alive

## Style Guidance
- Tone: tense
- Pacing: measured
- Atmosphere: gothic grandeur
```

## What a Good Response Looks Like

```
He rattled the gate again, the iron cold and wet against his palm. The sound
echoed through the night like a bone breaking. Nothing. He was about to turn,
to find some other way, when the door swung open without a sound.

The man who stood in the doorway was not a man. He was a wall, a slab of
muscle and silence, his face a mask of stone. A revolver hung in his hand,
the barrel a dark eye pointing at Rainsford's chest. Ivan, Rainsford thought.
The name from Whitney's rumors.

"I am Rainsford," he said, his voice a dry rasp. "I fell from a yacht. I
need shelter."

The giant did not move. He did not blink. His thumb found the hammer of the
revolver and drew it back. Click.

Then a voice from the shadows behind the giant: "Ivan." Soft, cultured,
almost bored. "Is that any way to treat a guest?"

General Zaroff stepped into the light.
```

## Common Failure Modes

| Failure | Symptom | Fix |
|---------|---------|-----|
| Thinking dump | Output starts with "Thinking. 1. Analyze..." | Use reasoning_effort=none or set max_tokens higher |
| Partial prose | Ends mid-sentence | Increase max_tokens, add "Output MUST end with a complete sentence" to rules |
| Missing facts | Prose contradicts world state | Make pre/postconditions explicit in "Expected Outcomes" |
| POV leak | "Whitney thought" in Rainsford POV | Repeat POV rule at top of writing instructions |
| Meta-commentary | "The scene ends here" or "[to be continued]" | Add: "The scene must feel complete — no meta-text" |
