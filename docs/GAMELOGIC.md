# Game logic survey

Where KCD's gameplay logic lives, and what running it in a browser would
take. Read-only survey of the GOG 1.9.8b install. Tools:
the inline scripts described below. This is a
map for later work.

## Summary

Most of the game's behaviour is **data**, interpreted by native code in
`WHGame.dll`:

| Layer | Where | Size | What a port needs |
|---|---|---|---|
| Behaviour trees (quests, NPC AI, daily life, dialogue flow, combat, crime) | `Libs/AI/**/*.xml` | 4,927 trees, 476 distinct node tags, 291k node uses | An interpreter plus implementations of ~466 node types |
| Quest structure | `Libs/Quests/flowgraphs/*.xml` (CryEngine FlowGraph) | 287 graphs, **16** node classes | A small graph interpreter |
| Character roles and schedules | `Libs/Storm/**/*.xml` ("Storm" rules) | 1,681 rules, ~15 element types | A rule evaluator |
| Game database | `Libs/Tables/**` (XML + binary `.tbl` twins; schema "hammerheart", exported from PostgreSQL) | ~270 MB, most of it localised text | Already parsed by the viewer (`web/src/tables.ts`) |
| Lua scripts | `Scripts/**/*.lua` (Lua 5.1 source) | 498 files, 90k lines, mostly entity definitions | Lua 5.1 in WASM plus the native API they call |
| Native code | `bin/Win64/WHGame.dll` (CryEngine 3.8 and the game, statically linked) | about 33 MB of x86-64 code | The engine is being replaced; the game modules must be reimplemented |

## Lua (Scripts.pak)

- **What's there.** 498 files (latest patch versions) and 90,113 lines,
  almost all under `Scripts/Entities/`: AI (67 files), Warhorse entities
  (44), archived (36), others, sound, multiplayer leftovers, physics,
  vehicles, boids, and so on.
- **Plain text.** Plain Lua 5.1 source, no bytecode.
- **Native APIs called** (`Name.fn(...)` sites):
  - CryEngine: `System` 1,222, `Sound` 320, `AI` 288, `Script` 281,
    `Game` 176, `CryAction` 126.
  - Warhorse: `XGenAIModule` 95, `QuestSystem` 79, `ItemManager` 55,
    `Calendar`, `Shops`, `CrimeUtils`, `Horsetraders`, `Trainers`,
    `NewHomesLuaAPI`, `DatabaseUtils`, …
- **Embedded Lua.** Behaviour trees also embed Lua via `ExecuteLua` nodes
  (4,633 uses).

## Behaviour trees (`Libs/AI`)

- **Files.** `Libs/AI/quests/*.xml` has 193 files (36 MB): one or more
  trees per quest, with persistent variables. `Libs/AI/final/**` has 403
  files (24 MB), including the `haste/` set.
- **Format:** `<BehaviorTrees><BehaviorTree name=…><Variables>…</Variables><Root>…`
  Variables are typed: `_bool`, `_float`, `common:wuid`, `common:vec3`,
  `dialog:state`, `questModule:onObjective`, …
- **Totals:** 4,927 trees and 291,523 node uses of 466 tags (excluding
  editor bookkeeping such as `OutputBreakpoints`).
  - Most used: `Sequence`, `IfCondition`, `Expression`, `SetQuestObjective`,
    `InstantSendMessageToNPC`, `QuestObjectiveCondition`, `GraphSearch`,
    `Wait`, `IncludeTree`, `Parallel`, `ExecuteLua`, `VarOperation`,
    `QuestObjectiveGate`.
- **Native modules behind the variable types:** `common` (9,669), `daycycle`
  (2,511), `dialog` (1,905), `combat` (1,193), `questModule`, `skirmish`,
  `trespass`, `battle`, `perception`, `player`, `interactionModule`,
  `questData`, `timekeeper`, `crime`, `door`, `garrison`, …
- **Test oracle.** The trees' XML gives every use of every node, which
  makes it a test oracle for an interpreter.

### Parsing (`web/src/bt.ts`)

- **Trees:** all 4,911 trees in 600 files parse in under 1 s.
  - `EditorData` is editor layout and is ignored.
  - `IncludeTree` targets are Libs/AI-relative paths, sometimes with
    backslashes. All 3,390 static includes resolve; 32 more name their
    target through variables at run time.
- **Properties:** a quoted property (`"…"` inside the XML attribute) is
  either an expression or plain text.
  - Plain text: Lua code, messages, include targets, GUIDs, categories,
    message types. `isTextProp` lists these.
  - Unquoted properties are raw literals: enum names, message types,
    variable names.
- **Expression language,** Lua-flavoured:
  - **Values:** `$var.field` paths, namespaced `$enum:type.value`,
    `'…'`/`"…"` strings, numbers, `true`/`false`.
  - **Durations and times:** `2s`, `500ms`, `1m 30s`, `2m40s`, `1.5h`;
    times of day `05:15`.
  - **Operators:** `#array` length; `== ~= != < <= > >=`;
    `and or not ! ~ & |`; `+ - * / %`; `?:`.
  - **Assignments:** `= += -= *= /=`, comma- or newline-separated.
  - **Other:** calls `f(…)`, indexing `a[b]`, `//` comments.
- **Coverage:** 371,749 of 371,770 expression properties parse (99.99%).
  The rest are data quirks.


### Interpreter (`web/src/btRuntime.ts`)

A standard tick interpreter (success / failure / running), not a model of
Warhorse's event executor. Semantics follow node names, properties and how
the shipped trees use them; guesses are marked `ASSUMPTION` in the code, to
check against the game later.

- **Nodes:** Root (OnInit, then Behavior), Sequence, Selector, Parallel
  (successMode / failureMode Any|All), IfCondition, IfElseCondition,
  RandomGate, While (doFail, propagateChildFail), Loop (count, −1 =
  forever), ForEach (array, startIndex, step, iterator, value, break), Wait
  (duration, −1 = forever; variation; GameTime/WorldTime; doFail), Success,
  Fail, Expression, VarOperation (Reinit, PushBack, Copy, Size, Find,
  Erase, Clear), IncludeTree, ExecuteLua and LuaWrapper (through the host).
- **Variables:**
  - Typed initial values; struct types start as `{}` and are filled field
    by field.
  - Included trees get a child scope, so forward-declared variables resolve
    to the caller's.
  - Durations are often stored as strings (`'10s'`); numeric contexts read
    them as seconds.
- **Host:** world-facing nodes and Lua go through a `Host` interface. Unknown
  tags are reported; leaves succeed and single-child nodes pass through.
- **Coverage:** 53% of the 156k node uses in the shipped trees are
  interpreted natively, plus 2,358 Lua nodes. The largest missing groups
  are quests (SetQuestObjective, QuestObjectiveCondition/Gate, ~13k),
  messages to NPCs (InstantSendMessageToNPC, 5.6k), the smart-object graph
  (GraphSearch, LinkTagFilter, Nodalyzer, ~9k) and locks or control
  (ExternalLock, Switch, FuseBox, SuppressFailure).
- **Tests:** `test-btrun.ts` checks the semantics on small trees and runs
  the tailor workplace's settings tree (`final/sa_tailory.xml`). Running
  the whole tailor tree shows what the world side must provide next:
  GraphSearch over the smart-object graph, and Lua.

### Smart objects and the world host (`web/src/btWorld.ts`)

**The data chain**, using Rataje's tailor as the example:

- **Smart-object graph.** It is the level's entity links (`EntityLinks` in
  `objects_mission0.xml`); link names are the edge tags (`Lean`, `inside`,
  `Home,owner`). Each entity's AI category is
  `Properties sWH_AI_EntityCategory` (14,125 entities); its smart-object
  type is `guidSmartObjectType`, its area template `guidSmartAreaTemplate`.
- **NPC → area.** `rat_tailor` → link `Work['tailor']` → `rat_sa_tailory`, a
  SmartAreaShape. The area links to the tailor's table (category
  `tailor_measuring`), two seats, two lean spots and a shop.
- **Area behaviours.** The area template → `sa_smart_area2sa_behaviour_tag`
  → `sa_behaviour_tag`: behaviour `tailor` = tree
  `final/sa_tailory.xml#tailor` (plus `tailor_setParams`). It includes the
  shared `final/sa_templates.xml#commonWorkplace`.
- **Smart-object behaviours.** The table's type `so_tailor_measuring` →
  `so_smart_object2so_behaviour_tag` → `so_behaviour_tag`: `use`,
  `use_default` and `setParams`, with tree file and name, `max_instances`
  (1 for `use`) and success/fail actions.
- **Helpers.** Positions and animations per smart-object class
  (`soclasses_SmartObjectHelpers`) are in `Libs/SmartObjects.xml`. For
  example `tailorTable` has one helper, `entry`, 0.5 m in front and turned
  180°, for `TailorIn` / `Tailor` / `TailorOut` (Mannequin fragment names).
- **Daily-cycle brain.** Area behaviours read `t_*` parameters
  (`$t_timeChanged`, …) owned by the NPC's daily-cycle brain
  `final/sb_daycycles.xml#root`. Its declared variables are provided with
  their initial values; the brain's own logic (schedule, activities,
  hobbies) is reimplemented in `web/src/daycycle.ts` from the research
  notes (see Daily schedules). Its side of each activity is
  `AiWorld.beginActivity` / `endActivity`: the NPC's `timeChanged` gate
  (an Intellect lock) is closed while an activity runs and opened, with
  `$t_timeChanged` set, when it ends. Behaviours wait on that gate to wind
  down (CityWalk's main loop runs in parallel with it). `$t_fastStart` is
  off: NPCs join the simulation near the player, so they walk rather than
  teleport.
- **Smart-object brains.** A smart-object type's `brain_id` →
  `brain2subbrain` → `subbrain_smart_object.on_update_tree` names its
  update tree (benches: `final/so_bench.xml#bench_onUpdate`). Its OnInit
  runs once before the object's first use: `uInit` counts the bench's
  `Sit` helpers into a `benchSize` self-link and sets the `use`
  behaviour's max instances. The rest of the update tree (message loops)
  doesn't run yet.

**World nodes.** The host implements:

- `GraphSearch` (depth, edge pruning, And/Or) with `CategoryFilter`,
  `LinkTagFilter`, `HasBehaviorFilter`, and `Nodalyzer` (ForAll / Exists
  into variables);
- `CallBehavior` (runs the target object's behaviour tree with `__object`,
  respecting `max_instances`, and raises `RequestOK` / `MaxInstance` /
  `BehSucces` / `BehFail` to `TryCatch` / `BehaviorTagCatch`);
- `ReserveBehavior` (reserves one instance of the found behaviour while its
  Exec runs; the NPC's own `CallBehavior` uses it), `LODGuardian` (Detail
  by default), `Synchronize`, `Semaphore` and `InstantSemaphore` (fails at
  once when full), external locks, `ActionHelperMapper` (a given helper
  index, else the helper offering the animation), `GetHelper(s)`,
  `GetSpatialInfo`, `Teleport`, `TurnBody`, `SmartObjSetBehaviorState` /
  `SmartObjSetBehaviorMaxInstances`, `RangeFilter` / `RangeSorter`, NPC
  messages (traced; `daycycle:change` goes to the NPC's daily cycle);
- **locks** (research notes, `bt-rules.md`): Global, Intellect (per NPC)
  and Local, which is the smart object or area instance whose behaviour
  runs, shared by its own brain and every NPC using it (CityWalk's lock
  per walk point; a bench's `<npc>_kickFromBench` gate, which another
  sitter opens). External locks start closed. Semaphores and
  synchronize locks are one counted lock: created free, waiters admitted
  in arrival order, and once the holders reach the count no one is
  admitted until all have left (batches; count 1 is a mutex, a
  two-party `Synchronize` a pairing barrier);
- **behaviour filters:** `HasBehaviorFilter` reads a smart object's type
  or a smart area's template (a shop's `customer`). Requestable means
  enabled with an instance free; Available means not disabled. Links
  carry their data in brackets (`benchSize[4]`, `benchUser[0]`), and a
  link from an entity to itself is a search result;
- `Move` / `MoveAndAct` / `PlayAnimation` as timed actions: walking at
  1.4 m/s, animations 4 s for now. `MoveAndAct` without a destination goes
  to the object's helper.

The runtime gained FuseBox, Switch, IfGate, SuppressFailure, AtomicDecorator,
VariableExistsGate, Concatenation and animation-event listeners. Unset
struct fields compare equal to their defaults ('' / 0 / false / null),
because struct schemas aren't loaded yet.

**Result** (`scripts/test-btworld.ts`): from `rat_tailor`'s work link alone,
the game's trees find the table, call its `use` behaviour, walk 2.9 m to
its `entry` helper, hand over to `use_default` and play `Tailor`, then take
the configured break at the area's bench.

**Still missing:** messages between NPCs and areas (`ProcessMessage`,
`ReadMessage`, `ClearInbox`: a garrison handing guards their posts, a
shop's merchant meeting customers), area brains (`CitySA_onUpdate`),
inventories and items, entity tags (`TagIt` runs its child), and the
graph filters `AnyLinkFilter`, `ExistPath`, `OrByRandomOp`. A behaviour
that returns early after reaching one of these is held (below), not
treated as the game ending the activity.

**Loops** follow `bt-rules.md`: `Loop count=N` repeats until N successes
and fails on the first failing child (−1, nearly every loop in the data,
repeats until a failure); `While` restarts its child whatever it returns
unless `propagateChildFail` is set; `LoopUntil` counts every result as an
attempt.

### In the world view (`web/src/npcAi.ts`, `web/src/mannequin.ts`)

- **When trees run.** NPCs near the player that have arrived where their
  daily cycle puts them (`updateAi` in `npcs.ts`) run their activity's
  behaviour: work at the Work link (`Work['tailor']` → `tailor`),
  `BreakfastEater` and `Eater` at home, the hobby drawn for free time
  (`cityWalk` on the city, `pray` at the church). When the activity
  changes, the tree winds down (the `timeChanged` gate opens) and is
  stopped after 20 s at most; the NPC walks on from where it stopped. A
  tree that returns before the time changes ends the activity early, as
  in the game: free time draws the next hobby, anything else is skipped
  until midnight and the next activity starts. If that tree reached a
  node this interpreter lacks, the NPC holds its spot instead (`gap` in
  `sim-daycycle.ts`).
- **Actions.**
  - **Moves:** a straight walk at 1.4 m/s that ends in the helper's
    orientation.
  - **Animations:** the Mannequin fragment's clip, looping, or holding the
    last frame for one-shots.
  - **Clock:** trees run on real time scaled like the game clock (×15 =
    real time).
- **Mannequin.** `Animations/Mannequin/ADB/kcd_<gender>_database.adb` lists
  per fragment ID the variants by tag set, with animation layers
  (`Tailor` → `tailor_idle`, looping, plus procedural variations
  `TailorVAR`). Names are aliases from the skeleton's `.chrparams`: for
  humans, `name="*" path="*\*.caf"` under `Animations\humans\<gender>`,
  i.e. a .caf's base name; the tracks are in the gender's DBAs
  (`male_tailor.dba`). Building the alias index reads all of a gender's
  DBAs (~3 s, once).
- **Result** (`render-world.ts --clock 10:00 --ai 30`):
  - in Rataje at 10:00, 16 NPCs near the market run their workplace trees
    (tailor, merchants, garrison guards, swordsmith, bailiff, city walkers,
    hanging out at home);
  - the tailor walks to his table's helper and plays `tailor_idle` at its
    long side, leaning over the cloth.

### Lua (`web/src/luaHost.ts`, `web/src/typeDefs.ts`)

- **Runtime.** `wasmoon-lua5.1` 1.18.10 (MIT) is the real Lua 5.1 VM
  compiled to WebAssembly (204 KB), pinned to a February 2024 release. In
  Lua 5.1, `10/2` prints `5` (5.3+ prints `5.0`) and `setfenv` and
  `table.getn` exist, so the scripts run unmodified. The `.wasm` is served
  locally: the package's default would fetch it from a CDN.
- **Usage in the scripts.** 90k lines across 498 files, plus 2,358
  tree-embedded snippets, use few 5.1-only features (`table.getn` 23×,
  `loadstring` 15×, `math.pow` 6×).
- **Start-up.** `Scripts/main.lua` defines `OnInit`, which loads the rest
  through `Script.ReloadScript` (`common.lua`, Utils, QuestUtils, Enum, …).
  After it, the game's scripts have defined 275 globals.
- **Implemented engine API.**
  - `Script.ReloadScript` / `LoadScript`.
  - `System.Log*`.
  - `CryAction.LoadXML(definition, data)`: schema-driven XML → Lua, from
    `Libs/LuaXML`.
  - `XGenAIModule.Get/SetBrainVariable`: a per-entity store.
  - **Enums:** the `enum_<name>` tables from `Libs/AI/TypeDefinitions.xml`
    (189 enums). Enums missing from it (`enum_FTIconType`,
    `enum_animationOverride`) answer `"<enum>.<value>"`.
- **Stubbed engine API.** Every other capitalised global is a logging stub:
  callable, returns nil, and answers nested keys. The host counts the
  calls (e.g. `entity.soul.AddMetaRoleByName`,
  `XGenAIModule.GetEntityByWUID`) to decide what to implement next.
- **Tree Lua.** `ExecuteLua` / `LuaWrapper` code runs as a chunk with
  `entity` (the NPC, with `entity.this.id`) and `data` (the tree's visible
  variables). Data goes in as JSON, decoded in Lua into proper 1-based
  tables, and changed variables are written back.
- **TypeDefinitions.xml.** 1,000 struct types (nested names joined with
  ':', members inherited) and 189 enums. Tree variables of struct types now
  start with the schema's member defaults; e.g. `cutsceneData` gets
  `mode = cutsceneMode.video`, `timeOfDay = -1`.
- **Database script API.** `GetTableInfo` (`LineCount`, `ColumnCount`),
  `GetColumnInfo`, `GetTableColumnData` (a 1-based column array) and
  `GetTableLine` (a row keyed by column name), with 0-based indices.
  - Values are typed by the table header (integer/real → number, boolean,
    empty → nil).
  - Lua calls are synchronous, so the tables whose names the scripts quote
    are preloaded (37, including the 8.9 MB `soul`).
  - With it, the game's start-up runs without errors; `EventSystem` fills
    its spawn pools from the soul table (597 souls).
- **Entities.** One persistent Lua table per entity, as in the engine:
  scripts keep state on it (e.g. `Contexts` stores `entity.contextsData`).
  - Only engine parts (`soul`, `human`, `actor`, `inventory`, …) and
    PascalCase methods are stubbed. Stubs never invent lower-case data
    fields.
  - An earlier version stubbed every field; that made `Context.lua` assert
    "already has the context option … active". The cause was the stubs,
    not the interpreter.
- **Brain variables.** `b_*` variables (`b_dialogParameters`, `b_context`,
  …) are declared from `Libs/Tables/ai/brain_variable` (types, initial
  values, forms 0 single / 1 array / 2 associative / 3 array) in the trees'
  global scope. Engine value types not in TypeDefinitions (`common:wuid`,
  `common:vec3`, …) start empty; other unknown types start as structs.
- **More engine API.**
  - `XGenAIModule.GetEntityByWUID` / `GetEntityIdByWUID`: WUIDs are entity
    ids here, giving the same persistent entity table.
  - `entity.soul` meta roles: `Add/Remove/HasMetaRoleByName`,
    `GetMetaRoles`. The work trees use these to make NPCs merchants or
    repairmen while working.
  - `TError`: recorded as an error.
  - `entity.Properties`: the entity's editor properties from the mission
    file, built lazily on first access (attributes, numeric text as
    numbers, child elements nested). `GetEntityScriptProperty` reads
    `Properties.Script` from these, for example a work area's
    `workBreakChance` override.
- **Status.** The work trees of Rataje's 16 market NPCs run with no Lua
  errors. The only engine call still stubbed on those paths is
  `EntityModule.GetSlotHand` (item slots).

## Dialogue (`Libs/Tables/text`, `web/src/dialogue.ts`)

- **The tables.** 52,415 sequences hold 201,190 lines.
  - `topic2sequence` lists a topic's sequences, each with entry conditions
    (expressions such as `var('3') AND var('4')`, see Conversations).
  - `sequence_line` orders a sequence's lines (`order_by`) and types them.
    Type 1 is a response, 84,632 of them, with a row in `response`: the
    speaking role, a `text_ui_dialog` key, camera mode and volume. Type 5
    is a command, 82,657 of them, in `v_dialogue_commands`. Types 2 and 4
    (2,618 and 31,281) have no table of their own.
  - `sequence` gives `next` (the topic that follows), `type`, `flags`,
    `priority` (menu order), `group`, `timeout`, `speech_coef`, a Lua
    `script` and a `ui_prompt` per sequence.
  - `v_branch` (8,926) gives the entry points: a start topic, a type
    (0 normal … 7 refusal), a priority and whether a greeting may come
    first; `topic` gives each topic's menu priority, speaking role, label
    and time limit; `topictorole` the role and metarole pairs a topic needs.
- **Commands.** Each has who and target (role ids), a type, `int_param`,
  `char_param` and a `delay` in seconds. Two types read plainly from the
  data:
  - type 1 sets a mood: `int_param` is a `dialogue_mood` id, e.g. 20 =
    `thinking1`;
  - type 3 plays a dialogue animation fragment, e.g. `char_param`
    `ADLG_Nod`.

  Type 8's `int_param` matches `dialogue_hearing` (bark ranges). The player
  reports commands but doesn't act on them yet: that waits for the
  dialogue animations (step 5).
- **The cast.** `soul2role` gives the roles a soul can play (the tailor has
  98). `v_soul_character_data` gives each soul's voice and its name key in
  `text_ui_soul`. Henry is role 3 (`HENRY`, metarole `PLAYER`); his lines
  are recorded in voice 108 (`tmck`).
- **Voices.** `v_response_wave_file_recorded` lists the recorded
  (line, voice) pairs, 156,884 of them. The file is always
  `Dialog/<path as six digits>/<voice abbreviation>_<text key>.ogg`
  (`v_voice_abbreviation`): Ogg Vorbis, mono, 48 kHz, in
  `Localization/<Language>*.pak`. Patches replace files in order, then
  the HD packs (`web/src/voice.ts`). Many lines were never recorded (most
  of the tailor's merchant topics, for one).
- **Playing (`web/src/dialoguePlayer.ts`).** A sequence becomes a timeline.
  Each response lasts as long as its recording in the speaker's voice
  (the Ogg's last granule position). A line with no recording stays up
  for a reading time we chose (0.06 s a character, at least 1.5 s); it is
  not the game's. The world view (`web/src/dialogueView.ts`) decodes the
  recordings with Web Audio and shows subtitles. It casts the first NPC
  near Henry that can play each role.
- **Cost.** Loaded on first use, about 1.5 s in Chrome. Kept in memory:
  64 MiB of tables, 11 MiB of text and a 49 MiB index of 148k recordings.
- **Conversations (`web/src/dialogueFlow.ts`, `dialogueCondition.ts`),**
  from the research note `dialogue.md`:
  - **Starting.** E talks to the NPC Henry faces (within 2.5 m) when it
    "has something to say": a branch of type 0, 1 or 5 whose roles fit
    and whose entry condition holds. A participant fits a role pair when
    it has the role and holds the metarole now: soul2metarole plus what
    behaviours grant. A shopkeeper holds `MERCHANT` and `REPAIRMAN`
    while his work behaviour runs, as the land's `goToSmartArea` grants
    them (`shop/shopkeeper`); the trade and repair branches need them.
  - **Narrowing.** Refusals win; then the top branch priority;
    player conversations over NPC-only ones; above priority 0 one is
    picked at random and plays at once.
  - **Greeting** (type 2) before the first choice, its follow-ups one
    random sequence per topic; **farewell** (type 3) a single barked line.
    The tailor's greeting script removes his `POZDRAV` metarole, so he
    greets once.
  - **The menu**: the game's stable merge sort (topic priority, then
    topic id + sequence priority), `(Back)` for type 7, `(End dialog)` at
    the top level, the "exhausted" marker, and a countdown bar for timed
    topics that takes the highlighted option at zero. A lone candidate
    mid-conversation plays without a menu. Flags 1 and 8 end the
    conversation (no return to the menu); flag 2 opens the price panel,
    a placeholder for now. Sequence timeouts (−1 once, N seconds of game
    time) make sequences unavailable after use.
  - **Conditions**: the condition language with actor indices and named
    conditions (`dialogue_functions`). All 16k entry conditions and 261
    named ones parse; `--` starts a comment. Quests, relationships, stats
    and items aren't modelled: their functions read "not started", 0,
    and a relationship of 0.5 (ASSUMPTION, the middle reputation band).
  - **Scripts** run in the game's Lua with `g_varContext`, `dc` (role →
    the participant's entity) and `Variables` over the dialogue's locals
    (kept per pair of participants) and globals.
  - **ASSUMPTIONs** for research: start branches match roles strictly
    (one pair per participant; greetings and farewells loosely), test
    branches are left out, owning start topics come from walking each
    branch's `next` links, and the NPC Henry talks to pauses its
    behaviour tree.
  - **Check** (`scripts/test-dialogue-flow.ts`, the note's walkthrough):
    with the shop open, the tailor greets, the menu is trade, repair,
    (End dialog); trade ends it with his farewell; without `MERCHANT`
    trade is gone; topic 6807 shows priorities 0, 1, 2 with a 10 s limit.
    In headless Chrome (`profile-browser.ts --talk=rat_tailor --pick=3`)
    the same conversation plays with his recorded voice.
- **Waiting on research notes:** which camera shot a line uses (and when it
  cuts); the price panel's details; what shops, bribes and trainers do
  after their sequences.
- **The dialogue camera rig (`web/src/dialogueCamera.ts`).** This part is
  in the data.
  - `dialog_cameras.chr` is a skeleton of camera bones: `master`,
    `medium`, `close_shot` and `close_up`, each with a `<name>_target`
    bone it looks at.
  - `male.cdf` attaches it at Henry's `Align` (his feet, facing +Y).
  - Its pose comes from the 3D blendspace `3d_ad_cameras_base.bspace`:
    45 one-pose clips named by where the partner stands
    (`ad_cam_base_y<height>_z<distance>_x<angle>`). The grid covers
    angles −180…180°, distances 80/140/250 cm and heights −45/0/45 cm,
    and each `SetPara` value rises with its label.
  - Between grid points the rig blends the eight corners trilinearly,
    piecewise linear in each label. That is our reading; the clip names
    give the layout.
  - The clips are the patched ones (`Data/patch/ipl_patch_010900.pak`;
    chest offset 1.45 m). In them every shot looks towards the partner
    (`close_up` within 19°, the others within 36°) from beside or behind
    Henry at head height. `master` is not a wide shot, as its name
    suggests: it is a close two-shot.
  - **Left out:** the mood and posture clips added on top
    (`ad_cam_base_stand_calm_add`, `…_bench_…`, `…_table_…`) and the
    lens. The view keeps its own field of view.
  - **In the view:** a debug picker (*Camera: …*) puts the camera on one
    shot while a dialogue plays. The rig sits on Henry and frames the NPC
    who spoke last; Henry switches to third person meanwhile so his head
    shows. `scripts/test-dialogue-camera.ts` checks the rig.
    `render-player.ts --at-npc rat_tailor --npc-dist 1.4 --dialogue-shot
    close_up` renders a shot with Henry facing the tailor.

## Quests (`Libs/Quests/flowgraphs`)

- **Scope.** 287 graphs, one per quest, using only 16 node classes:
  `Quest:Begin`, `Quest:End`, `Quest:Objective` (8,327),
  `Quest:AssetTracked`/`AssetNPC`/`AssetPlace`/`AssetItem`/`AssetStatistic`,
  and `Quest:Reward*` (exp, reputation, money, item, achievement, perk,
  script).
- **Division of labour.** Quest *structure* is here; quest *behaviour*
  (what NPCs do and when objectives change) is in the behaviour trees.
- **Database link.** Quests are rows in `Libs/Tables/quest/quest.xml`, and
  objectives in the `skald_*` tables ("Skald" is the quest/journal system).

## Storm (`Libs/Storm`)

Rule files assign roles, schedules and attributes to characters:
`<rule><selectors>…</selectors><operations>…</operations></rule>`.
- Selectors include `hasName`, `hasSocialClass`, `hasVoice`, `or`, ….
- Operations include `addRole`, `removeRole`, `addScheduleItem`,
  `setAttribute`, `modAttribute`, ….
- 1,681 rules, a small vocabulary.

## NPC placement (`objects_mission0.xml`)

- **Where.** Each level pak's `objects_mission0.xml` is the editor's
  entity list: 52 MB for Rataje, 55,122 entities in 71 classes (`TagPoint`
  10.5k, `ItemSlot`, `SmartObjectHolder`, `AreaShape`, `PickableItem`,
  `Stash`, `Bed` 1,302, `AnimDoor`, …).
- **NPCs.** 952 are `NPC` or `NPC_Female`, with `Pos`, `Rotate`
  (quaternion w,x,y,z, forward = +Y), links (`Work[…]` ×761, `Home,owner`,
  `futureWork[…]`, `preferedBed`, `cryofreeze` …) and properties such as
  `esModularBehaviorTree`, faction and perception.
- **Soul link.** There is no soul attribute: the **entity name is the soul
  name** (929 of 952 match a `soul_name`). The 23 unmatched are camp
  enemies and a few DLC characters.
- **Spawn heights.** 717 spawn on the terrain surface (±0.25 m) and 122 sit
  more than 1 m above it (upper floors).
- **Spawn spots are not live positions.** These are spawn spots; where an
  NPC actually is during the day comes from its schedule (Storm
  `addScheduleItem` plus the `daycycle` trees), via the linked home, work
  and bed entities.

The world view assembles the nearest 40 NPCs within 120 m from their souls
(`web/src/npcs.ts`). It stands each one at its spawn transform, playing
`relaxed_idle` from `male_general.dba` / `female_general.dba` with a random
phase. Test: `web/scripts/test-npcs.ts`.

## Daily schedules

- **Authoring.** Schedules are written as Storm rules
  (`Libs/Storm/schedules/**`, plus custom operations in
  `common/schedules.xml`). Example from `base.xml`: every valid open-world
  NPC gets morning 06:30, work 08:00, eat 12:30, work 14:30 and sleep
  20:30, each with a `scatter`. Other rules override this by social class,
  shop ownership, faction, name and so on.
- **Runtime data.** The resolved result is **baked into the soul table**
  (`activity_0..8`, `time_0..8`), with the scatter already applied: e.g.
  `rat_guard8` has work 7:56, sleep 20:56. A runtime doesn't need a Storm
  interpreter for schedules.
  - Activities across all souls: work 4,747, sleep 2,234, eat 1,902,
    morning 1,670, dummyWait 1,457, fun 616, leaveLevel 479, plus a few
    monastery and quest specials.
- **Where an activity happens** comes from the NPC entity's links:
  - `Work[…]` and `Home` point at `SmartAreaShape` polygons (points
    relative to the entity, rotated by its `Rotate`; 202 of 6,770 areas
    are rotated);
  - `preferedBed`/`owner` point at `Bed` entities.
- **Area sizes.** Work areas range from a workshop (median 19 m) to huge
  regions (10% are over 4 km across). In the real game, the behaviour
  trees choose a smart object inside them (a stall, a guard post).
- **Beds** (`web/src/npcs.ts`, `lyingTag` in `web/src/schedule.ts`):
  - **Pose.** A bed's kind (`Properties/Script esBedTypes`: normal, bench,
    ground, shelter, tent) and its helper class's side (`SleepingBench_Left`,
    `_Right`) pick the lying fragment, as the lie-down fragments do in
    `kcd_male_database.adb` (`LieDown` with `liePlaceBench+lieSideLeft`
    plays `laydown_bench_left`, then sets the idle state `lying` with
    tag `lyingLeft` → `sleeping_bench_idle_left`). Rataje's 1,302 beds:
    ground 560, bench 319, normal 244, shelter 138, tent 41. Women's
    general DBA has no bench clips; they use the bed pose.
  - **Place.** The helper class's lie-down helper (`lieSideLeft`/`Right`,
    else `lying`, else `Entry`) in the bed's frame.
  - **Align bone.** The lie-down fragments align the clip's `Align` bone
    with that helper (procedural `PositionAdjustAlignBone`, without z). The
    lying clips hold it turned 90° (−90° on the right side) and up to
    0.21 m aside, so the body, which lies along the character's Y, lies
    along the bed's X: its long side in the bed and bench models, and in
    the helpers (entries at ±0.85 m on Y, the wake-up spot 1.69 m aside on
    X). The character stands at helper × inverse(Align).
  - **Height.** Sleepers keep the helper's height: standing them on the
    collision surface put bench sleepers on the bench's top, 0.45 m too
    high.
  - **Check** (`web/scripts/test-beds.ts`): all 1,302 sleepers lie along
    their beds, over them, no more than 0.35 m above the top (three ground
    cloths that their data calls benches are not checked for height).
    Without the Align bone, 1,296 lie across.
- **The daily cycle** (`web/src/daycycle.ts`, from the research note
  `daily-cycle.md`; `scripts/test-daycycle.ts`):
  - **Schedule store.** Each NPC's base windows from the soul
    (`work_0_GH`, `fun_1_GH`, …; a window across midnight is one window),
    with patches laid over them by priority (the newest wins among
    overlapping equals). Skipping a window starts the next base entry
    early; skips last until midnight; once patches go when their
    behaviour succeeds. Trees add and remove patches with
    `daycycle:change` messages (now-or-never, cutscene priorities, times
    relative to now, immediate patches covering the day).
  - **Activities.** work → the Work link's area and behaviour; morning →
    home `BreakfastEater`; eat → home `Eater` (the game's 10% pub lunch
    for some men waits for a note on where the social class's
    `lunchInPub` comes from); sleep → home `Sleeper` (the bed placement
    below); fun → a hobby.
  - **Hobbies** (`soul2hobby.xml`, `hobby.xml`): drawn by mass and run on
    the nearest area offering them that the home's settlement reaches:
    the settlement containing the home (areas contain one another by
    position; the level has no parent links), its contained areas and
    `nearbyFun` links, less `suppressSearchHobby` ones. A hobby with no
    area is dropped for the window; with none left, fun ends and the NPC
    goes on to the next activity (bed, for most). Homes are left out but
    the NPC's own: whether a home offers its behaviours to strangers is
    an open point of the note. In Rataje at 19:00 the market's free-time
    NPCs walk the town (`cityWalk`: benches for 5–10 minutes, shops as
    customers, walk points), pray at the church, visit the bathhouse or
    the pub. NPCs have no needs: eating and sleeping happen because the
    schedule says so.
  - **cityWalk** starts where the NPC stands (the tailor leaves his shop
    at 18:31 and walks from its door), as its `_data` tree sets.
- **Where that puts them** (`web/src/schedule.ts`):
  - sleep → own bed (explicit links, then the beds inside the home polygon
    shared out among its residents: 651 of 952 NPCs get a bed);
  - work, morning, eat and hobbies → their area;
  - a hobby that starts where the NPC stands → where the last activity
    left it;
  - inside an area, use the spawn point if it lies in that area (about
    half do), else a stable pseudo-random point with walkable floor near
    the area's height, standing on it. An area can reach past its floor:
    the tailor's home is upstairs, but its polygon also covers the shop
    below, where he had stood 3.4 m up in the air.

  Rataje at 03:00: 577 in bed, 204 at work (night shifts). At 12:00: 643
  at work, 160 at home (`test-schedule.ts`, without the hobby data: free
  time then stays where work left the NPC).
- **Walking.** Each activity starts with a walk from the previous
  activity's place:
  - along the level's own navmesh (`web/src/navmesh.ts`, format in
    LEVELS.md): A* over polygons, crossing tile borders, then the funnel
    algorithm. Routes are cached per NPC and schedule item, and fall back to
    a straight line if no path is found. Guard 8's home → garrison route is
    109.5 m (straight line 106.9 m) and runs down the lane between the town
    wall and a palisade. Indexing Rataje's 58,056 tiles takes ~20 ms, and a
    route 1–13 ms;
  - speed taken from the walk clip's root motion: `relaxed_walk_medium`
    moves its root 3.03 m in 65 frames, 1.40 m/s for men and 1.29 m/s for
    women;
  - game time runs at 15× real time (4 real seconds per game minute);
  - the clip plays in place (root translation dropped) while the entity
    moves, facing the direction of travel.

  A walk long finished (even by a route four times the straight line) is
  not searched again: selection places every NPC of the level twice a
  second. At 08:05, 49 of Rataje's NPCs are on their way to work. Placement is
  recomputed every frame. The NPC set is re-streamed only when NPCs enter
  or leave the 40 nearest within 120 m.

## What this means for the port

1. **Don't emulate WHGame.dll.** It's 33 MB of x86-64 code tied to D3D11,
   Win32, Scaleform and CRI, and it is the CryEngine runtime itself.
   The browser side already replaces the engine's asset, render and
   animation layers.
2. **Reimplement the game layer as interpreters over the shipped data,**
   using the DLL as the specification:
   - **Database:** done (XML tables are parsed for character assembly).
     Extend to items, stats and quests.
   - **Lua 5.1:** run the shipped scripts in a WASM Lua 5.1 build, and
     implement the script-binding tables they call. Start from the call
     counts above: `System`, `AI`, `Script`, `Game`, then the Warhorse
     tables.
   - **Behaviour trees:** a tree interpreter plus the node types, in order
     of use. The structural and flow nodes (Sequence, If, Parallel, Wait,
     Expression, VarOperation, IncludeTree) cover a large share. The rest
     can be implemented one at a time, by node type.
   - **Quest flowgraphs (16 node types) and Storm rules:** small, and
     specified by the data plus the corresponding classes.
3. **Order of work.**
   - Start with what makes the world feel alive with the least simulation:
     NPCs placed by their daily schedules (`daycycle`), using the animation
     system already built.
   - Then dialogue (`dialog`; text is in the localisation tables, voices in
     `Localization/*.pak`) and a single quest end-to-end, e.g.
     `a_antiqueHooker` (a short side activity with a 16 KB flowgraph and a
     41 KB tree).
   - Combat and the RPG layer are the largest
     modules and come last.
4. **Clean room.** Where the data doesn't specify a behaviour, it is
   researched separately and written up as plain-language behaviour notes
   outside this repository. The code here is written from those notes;
   decompiled code is never committed (see CONTRIBUTING.md).

## Licensing note

The scripts and data (Lua, XML, tables) are the game's content: they're
read from your own install at runtime, like every other asset, and never
committed. Game logic is reimplemented clean-room: from the game's data,
observation, open-source libraries and plain-language behaviour notes kept
outside this repository. Decompiled code is never committed (see
CONTRIBUTING.md).

## Collision avoidance

`web/src/crowd.ts`, driven by `NpcWorld.stepCrowd`. An ORCA velocity
solver (van den Berg et al. 2011; the open-source RVO2 library) tuned to the
game's behaviour:

- **Agents and obstacles.** Moving NPCs avoid each other reciprocally.
  Standing NPCs, and NPCs about to reach their path end, are only avoided.
  At most 20 agents are solved per step, closest to someone else first.
- **Neighbours.** Each agent considers its 8 nearest moving neighbours and
  every standing NPC within 5 m, on the same floor.
- **Infeasible cases.** When no velocity is allowed, the agent tries the
  allowed region's boundary nearest to its preferred velocity, then drops
  far neighbours.
- **Shrink.** Agents that keep having to avoid slowly shrink the standing
  NPCs' radii, so they can squeeze past.
- **Body size.** Humans use the scripts' `pathRadius` 0.25 m
  (`npc_x.lua`) plus 0.075 m.
- **Viewer approximation.**
  - Planned positions (schedules, behaviour-tree moves) are the reference
    each NPC chases at walking speed, up to 1.3×.
  - NPCs without a running tree whose standing spot is taken move to the
    nearest free navmesh point. In the game they would run their own area
    trees, which hand out distinct spots.
- **Check.** `web/scripts/sim-crowd.ts` counts NPCs drawn inside one
  another over a minute of the market.

## NPC heights

Routes between schedule places take their height from the navmesh, which is
coarse: near Rattay's market, walking NPCs' planned height was 34 cm under
to 47 cm over the real surface (5th–95th percentile), and in places up to
0.85 m under the ground. The crowd step now puts every NPC on the walkable
surface under it (`NpcWorld.surface`: the player's collision world, terrain,
streets, bridges and floors), searching 0.5 m up and 1.5 m down from the
planned height, then 1 m up. The walk cycle advances with the distance each
NPC actually walks (the clip's own speed, 1.40 m/s male and 1.29 m/s female,
matches the walking speed, but NPCs catch up at up to 1.3× and slow down
around others), so the feet don't slide.
