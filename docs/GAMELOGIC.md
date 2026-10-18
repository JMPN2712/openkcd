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
  `final/sb_daycycles.xml#root`. Until that brain runs here, its declared
  variables are provided with their initial values.

**World nodes.** The host implements:

- `GraphSearch` (depth, edge pruning, And/Or) with `CategoryFilter`,
  `LinkTagFilter`, `HasBehaviorFilter`, and `Nodalyzer` (ForAll / Exists
  into variables);
- `CallBehavior` (runs the target object's behaviour tree with `__object`,
  respecting `max_instances`, and raises `RequestOK` / `MaxInstance` /
  `BehSucces` / `BehFail` to `TryCatch` / `BehaviorTagCatch`);
- `ReserveBehavior`, `LODGuardian` (Detail by default), `Synchronize`
  semaphores and external locks (Local / Intellect / Global scopes),
  `ActionHelperMapper`, `GetSpatialInfo`, NPC messages (traced);
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

**Still missing:** Lua, the daily-cycle brain itself, Mannequin fragment →
clip mapping, inventories and items, and HandCheck, For, LODLock / LODCheck,
NotNearPlayer, IsLoadedGate, RemoveLink.

### In the world view (`web/src/npcAi.ts`, `web/src/mannequin.ts`)

- **When trees run.** NPCs that have arrived at work (their schedule says
  "work" and they've finished walking) run their work area's behaviour,
  named by their Work link (`Work['tailor']` → `tailor`). The tree stops
  when the activity changes.
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
- **Beds.** The `Bed` smart-object class (`Libs/SmartObjects.xml`) has its
  `lying` helper at the entity origin with identity rotation, so a sleeper
  lies at the bed's own transform, playing `sleeping_bed_idle.caf`.
- **The viewer's approximation** (`web/src/schedule.ts`):
  - activity from the soul schedule;
  - sleep → own bed (explicit links, then the beds inside the home polygon
    shared out among its residents: 651 of 952 NPCs get a bed);
  - work → work area;
  - morning, eat, fun → home area;
  - inside an area, use the spawn point if it lies in that area (about
    half do), else a stable pseudo-random point.

  Rataje at 03:00: 577 in bed, 204 at work (night shifts). At 12:00: 637
  at work, 188 at home.
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

  At 08:05, 49 of Rataje's NPCs are on their way to work. Placement is
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

## Licensing note

The scripts and data (Lua, XML, tables) are the game's content: they're
read from your own install at runtime, like every other asset, and never
committed. Reimplementing behaviour from observation and decompilation for
private interoperability is a different legal question than redistributing
code; keep decompiled output out of the repo.
