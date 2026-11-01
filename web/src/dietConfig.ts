// Diet mode's data: which quests it cuts, what it rewires and what it grants instead. From the
// research notes' final diet-mode spec (diet-analysis, "Final decisions"); the logic is diet.ts.
// Quest, objective, item and shop names are the game data's own.

export interface DietGrant {
  /** item uuid (item/item) and its item_name, for reading */
  item: string;
  itemName: string;
  /** shop id (shop/shop) and its shop_name */
  shop: number;
  shopName: string;
  amount: number;
  /** what it replaces */
  lostWith: string;
}

export interface DietConfig {
  /** the cut quests, by line (quest_name) */
  cut: Record<string, string[]>;
  /**
   * Quests the main story needs: never cut, and the reachability test checks each can start, from
   * the quest named here ("dialogue": a conversation no quest owns; null: any kept source).
   */
  required: Record<string, string | null>;
  /** the main story (quest_type_id 1, group Main) is found in the data; these join it for the checks */
  mainHelpers: string[];
  /** quests that hold one objective per giver or count finished quests; starts aimed at them are expected */
  bookkeeping: string[];
  /** options inside kept quests that lead only into a cut quest (`when`, while it reads as cut): objectives never started, sequences hidden */
  rewire: Record<string, { objectives: string[]; sequences: number[]; why: string; when: string }>;
  /** unlocks a cut quest gave, stocked in a shop instead */
  grants: DietGrant[];
}

export const DIET: DietConfig = {
  cut: {
    bountyCamps: ["a_camps", "a_camps2", "a_camps3"],
    huntingErrands: ["a_huntsman_alex", "a_huntsman_butcher", "a_huntsman_chamberlain", "a_landlord", "a_currier"],
    theftErrands: ["a_pesek_thievery", "a_simon_thievery", "a_vojtech_thievery", "a_vagabund", "a_antiqueHooker", "q_jealousGroom"],
    fistFights: ["q_fightClub_rataje", "q_fightClub_skalice", "q_fightClub_uzice"],
    collectingAndChores: ["q_nightingales", "q_newHerbarium", "q_herbalistone", "q_torn_book", "a_swordofsheba"],
    smiths: ["q_secret_of_steel", "q_avalonSteel"],
    horsesAndMinigames: [
      "q_horse_on_the_run", "q_floatingArchery", "q_race_talmberk", "q_RacingAndBetting",
      "q_archery_rataje", "q_archery_skalice", "q_archery_uzice", "q_archery_mrchojedy", "q_archery_pribyslavice",
    ],
    cowsOfUzhitz: ["q_whoseCow", "q_killCow", "q_bodyOfChrist"],
    others: ["q_flirtTalmberk", "q_debtor", "q_troubleCorpse"],
  },
  required: {
    q_sazavaMonastery: "q_searchForSaint",
    q_plagueInMerhojed: "q_captiveInMerhojed",
    q_learnToRead: "dialogue",
    q_abductedWoman: "q_counterfeiters",
    q_tutorial_swordOne: null,
    q_activityswordtutorial: null,
  },
  mainHelpers: ["q_revenge", "q_tutorials", "q_master_main", "q_konradKyeser_tracker", "q_samopesh_tracker", "q_escapeToTalmberk_tracker", "q_counterOffensive_battle"],
  bookkeeping: ["q_questGivers", "q_activityGivers", "q_master_main"],
  rewire: {
    q_recruiters: {
      // the "Ask Miller Simon" route needs Thick as Thieves – Simon; the tanner, bailiff,
      // innkeeper and Thomas routes stay (checkSasoInnkeeper opens once askSimon stays unchanged)
      objectives: ["talkToSimon", "askSimon", "simonLog", "simonToldHenryAboutRecruiters", "bailiffSendMeToSimon", "bailiffSendMeToSimonAndKozka", "patch5_getSimonTrust"],
      // the Sasau innkeeper's "What about that miller, Simon?", which only points at Simon
      sequences: [37674],
      why: "the Simon route needs a cut quest",
      when: "a_simon_thievery",
    },
  },
  grants: [
    { item: "e69bf96e-47ff-4eb2-a9b3-06dc896d43b8", itemName: "skillbook_agility1", shop: 139, shopName: "aus_scribe", amount: 1, lostWith: "q_fightClub_uzice" },
    { item: "41f6e46c-bca6-16da-169a-f0c8f1a6e2ab", itemName: "saddle (ui_nm_horse_saddle_004d)", shop: 130, shopName: "neu_stables", amount: 1, lostWith: "q_RacingAndBetting" },
    { item: "41c05047-74e5-f23d-1fe8-b0a8db360087", itemName: "trappings_010", shop: 128, shopName: "aus_stables", amount: 1, lostWith: "q_horse_on_the_run" },
    // its own price (16,442) is already a top sword's: the best shop swords cost 9–13k
    { item: "d459cb3a-04b5-4de7-b115-35ec17d293ba", itemName: "sword_of_queen_of_sheba", shop: 80, shopName: "sas_shop_swordsmith_new", amount: 1, lostWith: "a_swordofsheba" },
  ],
};

/** Every cut quest name. */
export const cutQuests = (c: DietConfig = DIET): string[] => Object.values(c.cut).flat();
