import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SCHEDULE_TEMPLATES } from "./templates";

const formats = ["eight", "twelve", "sixteen"] as const;
const expectedSlotCounts = { eight: 8, twelve: 12, sixteen: 16 };
const expectedGroupMatchupCounts = { eight: 12, twelve: 18, sixteen: 24 };
const expectedKnockoutMatchupCounts = { eight: 7, twelve: 7, sixteen: 7 };

describe("SCHEDULE_TEMPLATES", () => {
  for (const fmt of formats) {
    describe(`${fmt}-team format`, () => {
      const t = SCHEDULE_TEMPLATES[fmt];

      it("slot count matches league size", () => {
        expect(t.slots).toHaveLength(expectedSlotCounts[fmt]);
      });

      it("group matchup count is correct", () => {
        expect(t.groupMatchups).toHaveLength(expectedGroupMatchupCounts[fmt]);
      });

      it("knockout matchup count is correct", () => {
        expect(t.knockoutMatchups).toHaveLength(expectedKnockoutMatchupCounts[fmt]);
      });

      it("every slot appears exactly 3 times across group matchups", () => {
        const counts = new Map<string, number>();
        for (const m of t.groupMatchups) {
          counts.set(m.homeSlot, (counts.get(m.homeSlot) ?? 0) + 1);
          counts.set(m.awaySlot, (counts.get(m.awaySlot) ?? 0) + 1);
        }
        for (const slot of t.slots) {
          expect(counts.get(slot), `slot ${slot} appearance count`).toBe(3);
        }
      });

      it("matchIndex is 1-indexed and contiguous within each group round", () => {
        const rounds = ["group_md1", "group_md2", "group_md3"] as const;
        for (const round of rounds) {
          const indexes = t.groupMatchups
            .filter(m => m.round === round)
            .map(m => m.matchIndex)
            .sort((a, b) => a - b);
          const expected = Array.from({ length: indexes.length }, (_, i) => i + 1);
          expect(indexes, `round ${round} matchIndexes`).toEqual(expected);
        }
      });

      it("matchIndex is 1-indexed and contiguous within each knockout round", () => {
        const rounds = ["qf", "sf", "final"] as const;
        for (const round of rounds) {
          const indexes = t.knockoutMatchups
            .filter(m => m.round === round)
            .map(m => m.matchIndex)
            .sort((a, b) => a - b);
          const expected = Array.from({ length: indexes.length }, (_, i) => i + 1);
          expect(indexes, `round ${round} matchIndexes`).toEqual(expected);
        }
      });

      it("no duplicate (round, matchIndex) pairs in group matchups", () => {
        const seen = new Set<string>();
        for (const m of t.groupMatchups) {
          const key = `${m.round}:${m.matchIndex}`;
          expect(seen.has(key), `duplicate ${key}`).toBe(false);
          seen.add(key);
        }
      });

      it("no duplicate (round, matchIndex) pairs in knockout matchups", () => {
        const seen = new Set<string>();
        for (const m of t.knockoutMatchups) {
          const key = `${m.round}:${m.matchIndex}`;
          expect(seen.has(key), `duplicate ${key}`).toBe(false);
          seen.add(key);
        }
      });
    });
  }

  describe("8-team BYE representation", () => {
    const t = SCHEDULE_TEMPLATES.eight;

    it("qf has exactly 4 entries", () => {
      expect(t.knockoutMatchups.filter(m => m.round === "qf")).toHaveLength(4);
    });

    it("exactly 2 qf entries have awaySeedSource === 'BYE'", () => {
      const byeEntries = t.knockoutMatchups.filter(
        m => m.round === "qf" && m.awaySeedSource === "BYE"
      );
      expect(byeEntries).toHaveLength(2);
    });

    it("BYE entries have homeSeedSource '1A' and '1B'", () => {
      const byeHomes = t.knockoutMatchups
        .filter(m => m.round === "qf" && m.awaySeedSource === "BYE")
        .map(m => m.homeSeedSource)
        .sort();
      expect(byeHomes).toEqual(["1A", "1B"]);
    });
  });
});
