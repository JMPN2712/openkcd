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
