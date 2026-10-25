# Playing OpenKCD

OpenKCD runs Kingdom Come: Deliverance in your browser from **your own copy of
the game**. It is early: you can walk the whole map as Henry, among NPCs going
about their day, but there is no combat, dialogue or quest system yet (see the
README's "Current status"). Everything happens on your machine: the game is
converted into your browser's private storage and nothing is uploaded.

## What you need

- **A Chromium-based browser with WebGPU:** Google Chrome, Chromium or Edge.
  Firefox and Safari are not supported yet.
  - **On Linux,** turn on Vulkan (`chrome://flags/#enable-vulkan`, or start
    Chrome with `--enable-features=Vulkan`), and on Wayland also start it
    with `--ozone-platform=x11`. Without Vulkan, Chrome on Linux finds no
    WebGPU adapter. The start page's GPU line should name your real GPU.
- **A GPU with BC texture compression** (any desktop GPU of the last decade,
  and integrated AMD and Intel graphics). The Potato preset aims at an AMD
  Vega 7 laptop.
- **16 GB of RAM** recommended.
- **Free disk space** for the browser's storage: see
  [How much space](#how-much-space).
- **The game: the GOG offline installer** of Kingdom Come: Deliverance (PC).

## Getting the GOG offline installer

In your GOG account, open the game in your library (on gog.com, or in GOG
Galaxy under the game's settings) and download the **offline backup game
installers**: `setup_kingdom_come_deliverance_….exe` and its numbered `.bin`
files (about 56 GiB for the base game; GOG lets you download them one at a
time). Keep them in one folder. The DLC installers can go in the same folder
or a `DLC` subfolder; OpenKCD finds them. You don't need to run the
installers.

An already installed copy of the game also works: pick its folder (the one
with `Data` and `bin`) with **Open KCD folder**, and OpenKCD reads it in
place. The rest of this page is about the installer, which you can delete
afterwards.

## Installing

1. Open the OpenKCD page: <https://openkcd.jmpn.workers.dev/> (or your own
   build, see [BUILDING.md](BUILDING.md)). The installed game is kept for
   that address, in your browser. Installing it as an app (Chrome's install
   button in the address bar) is recommended: Chrome then keeps its storage,
   instead of clearing it when the disk runs low.
2. Click **Install from GOG installer** and pick the installer folder, or drop
   the folder onto the page.
3. Choose what to install:
   - **Compact package, Potato:** textures up to 512 px, for low-end laptops.
     The smallest.
   - **Compact package, Full:** textures at full resolution.
   - **The game's archives:** the original `.pak` files, copied as they are
     (without the files later patches replace).

   Choose the voice-over language too. The compact packages leave out the
   cutscene videos; you can add them later (below).
4. Click **Install** and wait: about ten minutes for a compact package on a
   fast machine.
5. When it says *Ready*, the installer files are no longer needed. From then
   on, the start page offers **Open compact package** (or **Open installed
   copy**).
6. Open **World: Rataje** in the sidebar, pick a quality preset, and click
   the view to play.

An interrupted install (closing the tab, Cancel, a full disk) carries on
where it stopped when you install again.

### Low on disk space: part by part

You don't need the whole installer at once. Put the `.exe` and **the base
game's last two `.bin` slices** in the folder, and install. OpenKCD converts
what those slices hold, then tells you which slice to add next and which ones
you may delete. Add that slice, pick the folder again, and repeat. It asks for
the slices from last to first, then the DLC's. So the disk only ever holds two
slices (about 8.6 GiB) plus the browser's copy.

### Cutscene videos

They are left out of the compact packages (about 15 GiB). To add them later,
pick the installer folder again and choose **Install: the cutscene videos,
into the compact package built here**. OpenKCD does not play them yet.

### How much space

Browser storage, base game and all DLC, one voice language:

| What you install | While installing (peak) | When done |
|---|---:|---:|
| Compact package, Potato, every slice present | 12.8 GiB | **12.8 GiB** |
| Compact package, Potato, part by part | 16.1 GiB | **12.8 GiB** |
| Compact package, Full, every slice present | about 21.4 GiB | **21.4 GiB** |
| Compact package, Full, part by part | 29.5 GiB | **21.4 GiB** |
| The game's archives (cutscene videos included) | 52.5 GiB | **38.2 GiB** |
| Cutscene videos, added to a compact package later | +15 GiB | +15 GiB |

Browsers allow a site a share of the free disk space, so leave a few GiB more
than the peak. The installer files are extra: all of them (about 56 GiB for
the base game), or two slices at a time part by part.

## Quality presets

Pick one in the world view (saved per browser). Medium is the default.

| Preset | For | Textures | Shadows | Render scale | Streamed radius |
|---|---|---|---|---|---|
| Potato | integrated GPUs (AMD Vega 7) | up to 512 px | off | 50% | 200 m |
| Low | older or weaker GPUs | up to 1024 px | 1 cascade | 75% | 300 m |
| Medium | mid-range GPUs | up to 1024 px | 2 cascades | 100%, 4× MSAA | 500 m |
| High | recent discrete GPUs | up to 2048 px | 2 cascades, sharper | 100%, 4× MSAA | 700 m |

The HUD shows the frame rate. The Potato package holds textures up to 512 px,
so with it the higher presets don't sharpen textures (shadows and distance
still follow the preset).

## Controls

Click the view to capture the mouse; Esc releases it.

| Key | Action |
|---|---|
| Mouse | look |
| W A S D, arrows | move |
| Shift | sprint |
| X or Caps Lock | walk / run |
| Space | jump |
| V | first / third person |
| Mouse wheel | third-person camera distance (1–8 m) |
| E | open or close the door or chest you face (a prompt below the middle of the view says when one is in reach; locked ones stay shut); an open chest lists what it holds; on a bed, sleep until 7:00 |
| F | free-fly camera (debugging): drag to look, W A S D to move, Space/E up, C/Q down, Shift faster |
| T | in free-fly: put Henry under the camera |

## Known issues

- **No gameplay yet:** no combat, dialogue, quests, inventory or saves. NPCs
  follow their daily routines but don't react to Henry.
- **Doors:** Henry opens and closes them (E) without his hand animation;
  locked doors can't be opened yet (no keys or lockpicking); NPCs walk
  through closed doors; no door sounds.
- **Chests** show what they hold, but nothing can be taken yet (no
  inventory), and the random part of their loot isn't rolled: the list
  shows what they may hold.
- **Cutscene videos** don't play.
- **Water:** rivers whose surface is flat don't flow; waterfalls don't move.
- **Sky:** no clouds or weather.
- **Distance:** beyond the streamed radius, forests are trees on the terrain
  colour, without bushes.
- **NPCs** in Rattay spend much of midday indoors.
- **Linux:** without the Vulkan flag Chrome has no WebGPU; on Wayland, without
  `--ozone-platform=x11`, the view glitches until a reload.
- **First load:** opening the world takes a while (about 10 to 20 s for the
  world from a compact package, longer from the game's archives).
- **The Potato preset hasn't been measured on its target** (a Vega 7 laptop)
  yet, and macOS is still being tried (an Apple M3 Pro). See [COMPATIBILITY.md](COMPATIBILITY.md) for what has been tested.

Please report problems with the issue form, saying where in the world it
happened (the HUD shows the coordinates). Don't attach game files.
