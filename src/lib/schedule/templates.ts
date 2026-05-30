import "server-only";

export type GroupMatchupTemplate = {
  round: "group_md1" | "group_md2" | "group_md3";
  homeSlot: string;
  awaySlot: string;
  matchIndex: number;
};

export type KnockoutMatchupTemplate = {
  round: "qf" | "sf" | "final";
  homeSeedSource: string;
  awaySeedSource: string;
  matchIndex: number;
};

export type ScheduleTemplate = {
  slots: string[];
  groupMatchups: GroupMatchupTemplate[];
  knockoutMatchups: KnockoutMatchupTemplate[];
};

export const SCHEDULE_TEMPLATES: Record<"eight" | "twelve" | "sixteen", ScheduleTemplate> = {
  eight: {
    slots: ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4"],
    groupMatchups: [
      { round: "group_md1", homeSlot: "A1", awaySlot: "A2", matchIndex: 1 },
      { round: "group_md1", homeSlot: "A3", awaySlot: "A4", matchIndex: 2 },
      { round: "group_md1", homeSlot: "B1", awaySlot: "B2", matchIndex: 3 },
      { round: "group_md1", homeSlot: "B3", awaySlot: "B4", matchIndex: 4 },
      { round: "group_md2", homeSlot: "A1", awaySlot: "A3", matchIndex: 1 },
      { round: "group_md2", homeSlot: "A2", awaySlot: "A4", matchIndex: 2 },
      { round: "group_md2", homeSlot: "B1", awaySlot: "B3", matchIndex: 3 },
      { round: "group_md2", homeSlot: "B2", awaySlot: "B4", matchIndex: 4 },
      { round: "group_md3", homeSlot: "A1", awaySlot: "A4", matchIndex: 1 },
      { round: "group_md3", homeSlot: "A2", awaySlot: "A3", matchIndex: 2 },
      { round: "group_md3", homeSlot: "B1", awaySlot: "B4", matchIndex: 3 },
      { round: "group_md3", homeSlot: "B2", awaySlot: "B3", matchIndex: 4 },
    ],
    knockoutMatchups: [
      { round: "qf", homeSeedSource: "2A", awaySeedSource: "3B", matchIndex: 1 },
      { round: "qf", homeSeedSource: "2B", awaySeedSource: "3A", matchIndex: 2 },
      { round: "qf", homeSeedSource: "1A", awaySeedSource: "BYE", matchIndex: 3 },
      { round: "qf", homeSeedSource: "1B", awaySeedSource: "BYE", matchIndex: 4 },
      { round: "sf", homeSeedSource: "winner_qf_3", awaySeedSource: "winner_qf_1", matchIndex: 1 },
      { round: "sf", homeSeedSource: "winner_qf_4", awaySeedSource: "winner_qf_2", matchIndex: 2 },
      { round: "final", homeSeedSource: "winner_sf_1", awaySeedSource: "winner_sf_2", matchIndex: 1 },
    ],
  },

  twelve: {
    slots: ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3", "D1", "D2", "D3"],
    groupMatchups: [
      { round: "group_md1", homeSlot: "A1", awaySlot: "A2", matchIndex: 1 },
      { round: "group_md1", homeSlot: "B1", awaySlot: "B2", matchIndex: 2 },
      { round: "group_md1", homeSlot: "C1", awaySlot: "C2", matchIndex: 3 },
      { round: "group_md1", homeSlot: "D1", awaySlot: "D2", matchIndex: 4 },
      { round: "group_md1", homeSlot: "A3", awaySlot: "B3", matchIndex: 5 },
      { round: "group_md1", homeSlot: "C3", awaySlot: "D3", matchIndex: 6 },
      { round: "group_md2", homeSlot: "A1", awaySlot: "A3", matchIndex: 1 },
      { round: "group_md2", homeSlot: "B1", awaySlot: "B3", matchIndex: 2 },
      { round: "group_md2", homeSlot: "C1", awaySlot: "C3", matchIndex: 3 },
      { round: "group_md2", homeSlot: "D1", awaySlot: "D3", matchIndex: 4 },
      { round: "group_md2", homeSlot: "A2", awaySlot: "B2", matchIndex: 5 },
      { round: "group_md2", homeSlot: "C2", awaySlot: "D2", matchIndex: 6 },
      { round: "group_md3", homeSlot: "A2", awaySlot: "A3", matchIndex: 1 },
      { round: "group_md3", homeSlot: "B2", awaySlot: "B3", matchIndex: 2 },
      { round: "group_md3", homeSlot: "C2", awaySlot: "C3", matchIndex: 3 },
      { round: "group_md3", homeSlot: "D2", awaySlot: "D3", matchIndex: 4 },
      { round: "group_md3", homeSlot: "A1", awaySlot: "B1", matchIndex: 5 },
      { round: "group_md3", homeSlot: "C1", awaySlot: "D1", matchIndex: 6 },
    ],
    knockoutMatchups: [
      { round: "qf", homeSeedSource: "1A", awaySeedSource: "2B", matchIndex: 1 },
      { round: "qf", homeSeedSource: "1B", awaySeedSource: "2A", matchIndex: 2 },
      { round: "qf", homeSeedSource: "1C", awaySeedSource: "2D", matchIndex: 3 },
      { round: "qf", homeSeedSource: "1D", awaySeedSource: "2C", matchIndex: 4 },
      { round: "sf", homeSeedSource: "winner_qf_1", awaySeedSource: "winner_qf_3", matchIndex: 1 },
      { round: "sf", homeSeedSource: "winner_qf_2", awaySeedSource: "winner_qf_4", matchIndex: 2 },
      { round: "final", homeSeedSource: "winner_sf_1", awaySeedSource: "winner_sf_2", matchIndex: 1 },
    ],
  },

  sixteen: {
    slots: [
      "A1", "A2", "A3", "A4",
      "B1", "B2", "B3", "B4",
      "C1", "C2", "C3", "C4",
      "D1", "D2", "D3", "D4",
    ],
    groupMatchups: [
      { round: "group_md1", homeSlot: "A1", awaySlot: "A2", matchIndex: 1 },
      { round: "group_md1", homeSlot: "A3", awaySlot: "A4", matchIndex: 2 },
      { round: "group_md1", homeSlot: "B1", awaySlot: "B2", matchIndex: 3 },
      { round: "group_md1", homeSlot: "B3", awaySlot: "B4", matchIndex: 4 },
      { round: "group_md1", homeSlot: "C1", awaySlot: "C2", matchIndex: 5 },
      { round: "group_md1", homeSlot: "C3", awaySlot: "C4", matchIndex: 6 },
      { round: "group_md1", homeSlot: "D1", awaySlot: "D2", matchIndex: 7 },
      { round: "group_md1", homeSlot: "D3", awaySlot: "D4", matchIndex: 8 },
      { round: "group_md2", homeSlot: "A1", awaySlot: "A3", matchIndex: 1 },
      { round: "group_md2", homeSlot: "A2", awaySlot: "A4", matchIndex: 2 },
      { round: "group_md2", homeSlot: "B1", awaySlot: "B3", matchIndex: 3 },
      { round: "group_md2", homeSlot: "B2", awaySlot: "B4", matchIndex: 4 },
      { round: "group_md2", homeSlot: "C1", awaySlot: "C3", matchIndex: 5 },
      { round: "group_md2", homeSlot: "C2", awaySlot: "C4", matchIndex: 6 },
      { round: "group_md2", homeSlot: "D1", awaySlot: "D3", matchIndex: 7 },
      { round: "group_md2", homeSlot: "D2", awaySlot: "D4", matchIndex: 8 },
      { round: "group_md3", homeSlot: "A1", awaySlot: "A4", matchIndex: 1 },
      { round: "group_md3", homeSlot: "A2", awaySlot: "A3", matchIndex: 2 },
      { round: "group_md3", homeSlot: "B1", awaySlot: "B4", matchIndex: 3 },
      { round: "group_md3", homeSlot: "B2", awaySlot: "B3", matchIndex: 4 },
      { round: "group_md3", homeSlot: "C1", awaySlot: "C4", matchIndex: 5 },
      { round: "group_md3", homeSlot: "C2", awaySlot: "C3", matchIndex: 6 },
      { round: "group_md3", homeSlot: "D1", awaySlot: "D4", matchIndex: 7 },
      { round: "group_md3", homeSlot: "D2", awaySlot: "D3", matchIndex: 8 },
    ],
    knockoutMatchups: [
      { round: "qf", homeSeedSource: "1A", awaySeedSource: "2B", matchIndex: 1 },
      { round: "qf", homeSeedSource: "1B", awaySeedSource: "2A", matchIndex: 2 },
      { round: "qf", homeSeedSource: "1C", awaySeedSource: "2D", matchIndex: 3 },
      { round: "qf", homeSeedSource: "1D", awaySeedSource: "2C", matchIndex: 4 },
      { round: "sf", homeSeedSource: "winner_qf_1", awaySeedSource: "winner_qf_3", matchIndex: 1 },
      { round: "sf", homeSeedSource: "winner_qf_2", awaySeedSource: "winner_qf_4", matchIndex: 2 },
      { round: "final", homeSeedSource: "winner_sf_1", awaySeedSource: "winner_sf_2", matchIndex: 1 },
    ],
  },
};
