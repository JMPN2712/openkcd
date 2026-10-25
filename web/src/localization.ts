// The game's text in one language: Localization/<Language>_xml.pak holds text_ui_*.xml tables
// (items, dialogue, quests, menus, …), rows of three cells: the key, the original English text and
// the translation:
//
//   <Table><Row><Cell>ui_nm_club</Cell><Cell>Bludgeon</Cell><Cell>Bludgeon</Cell></Row>…
//
// Every language's pak uses the same file names at its root, so a pak is picked by its path (the
// installer and the compact package's store keep it) rather than through the shared VFS.

import type { PakSource } from "./paks.ts";
import { readCentralDirectory, readEntry } from "./zip.ts";

export class Localization {
  private text = new Map<string, string>();

  /** Look up a key ("ui_nm_club"); undefined when the loaded tables don't have it. */
  get(key: string): string | undefined {
    return this.text.get(key.toLowerCase());
  }

  /**
   * Load tables (e.g. "text_ui_items") from `language`'s text pak among `paks`; tables already
   * loaded are kept. Returns false without that pak.
   */
  async load(paks: PakSource[], tables: string[], language = "english"): Promise<boolean> {
    const pak = paks.find((p) => p.path.toLowerCase().replace(/\\/g, "/").endsWith(`localization/${language}_xml.pak`));
    if (!pak) return false;
    const blob = await pak.open();
    const entries = await readCentralDirectory(blob);
    for (const t of tables) {
      const e = entries.find((x) => x.name.toLowerCase() === `${t.toLowerCase()}.xml`);
      if (!e) continue;
      const xml = new TextDecoder().decode(await readEntry(blob, e));
      for (const m of xml.matchAll(/<Row><Cell>([^<]*)<\/Cell><Cell>([^<]*)<\/Cell>(?:<Cell>([^<]*)<\/Cell>)?/g)) {
        this.text.set(m[1].toLowerCase(), unescape(m[3] || m[2]));
      }
    }
    return true;
  }
}

function unescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
