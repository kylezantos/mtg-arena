---
title: "feat: Secrets of Strixhaven Pre-Release Research Brief"
type: feat
status: completed
date: 2026-04-04
---

# Secrets of Strixhaven Pre-Release Research Brief

## Overview

Create a comprehensive research brief to prepare Kyle for the Secrets of Strixhaven pre-release weekend (April 17-23, 2026). Kyle started playing MTG about a week ago (primarily on MTG Arena) and needs to choose which college to pick for his prerelease kit(s) and potentially which commander precon to buy. The brief should be beginner-friendly while giving him a genuine strategic edge.

## Problem Frame

Pre-release events require choosing a college before you sit down — your kit includes a seeded booster in your college's colors. Making an informed choice matters because 1 of your 6 boosters will be weighted toward that college. Kyle needs to understand all five colleges, their mechanics, strengths in sealed/draft, and which aligns best with a newer player's skill level. He also needs general sealed deck-building fundamentals since pre-release is sealed format (not draft, though some stores run side drafts).

## Requirements Trace

- R1. Explain all 5 colleges: colors, mechanics, playstyle, and identity
- R2. Explain set-wide mechanics (Prepared, Paradigm, Converge, Mystical Archive)
- R3. Provide a clear college recommendation with reasoning for a new player
- R4. Cover sealed deck-building fundamentals (40-card deck, mana curve, removal, etc.)
- R5. Cover the 5 commander precon decks with recommendations
- R6. Include practical prerelease logistics and tips
- R7. Write for a reader with ~1 week of MTG experience (MTGA background)

## Scope Boundaries

- This is a research brief document, not code
- Focus on Secrets of Strixhaven (2026), not the original Strixhaven (2021)
- No card-by-card tier lists (spoiler season is still active)
- No price speculation or financial advice beyond noting precon reprint values

## Key Technical Decisions

- **Format:** Markdown document in `docs/` — easy to read, reference, and update
- **Structure:** Top-down from "what do I need to know right now" to deeper detail
- **Tone:** Conversational, beginner-friendly, opinionated where warranted

## Research Summary

### Colleges & Mechanics (Verified from official Wizards sources)

| College | Colors | Mechanic | How It Works |
|---------|--------|----------|--------------|
| Silverquill | W/B | Repartee | Triggers when you cast instants/sorceries targeting creatures |
| Prismari | U/R | Opus | Triggers on instants/sorceries; bonus if 5+ mana spent |
| Witherbloom | B/G | Infusion | Bonus effects if you gained life this turn |
| Lorehold | W/R | Flashback | Cast instants/sorceries from graveyard at flashback cost |
| Quandrix | U/G | Increment | +1/+1 counters when mana spent > creature's power/toughness |

### Set-Wide Mechanics
- **Prepared:** Creatures enter with a linked spell in exile you can cast once
- **Paradigm:** Sorceries that exile and recast themselves each turn for free
- **Converge:** Rewards casting with multiple colors of mana
- **Book:** New artifact subtype
- **Mystical Archive:** Bonus sheet of iconic instants/sorceries (1 per pack)

### Commander Precons (Power Ranking)
1. Silverquill Influence ($214 reprint value) — Killian, auras/politics/goad
2. Lorehold Spirit ($188) — Quintorius planeswalker, graveyard/Spirits
3. Prismari Artistry ($165) — Rootha/Veyran, big spells/Elementals
4. Quandrix Unlimited ($150) — Zimone/Primo, +1/+1 counters/X-spells
5. Witherbloom Pestilence ($133) — Dina, sacrifice/life drain

### Prerelease Kit Contents
- 5 Play Boosters + 1 college-seeded booster
- 1 traditional foil promo rare/mythic
- 1 deck box + 1 spindown die (college-themed)

### Beginner Recommendations (from multiple sources)
- **Best precon for new players:** Lorehold Spirit (easy to follow) or Witherbloom Pestilence (consistent out of the box)
- **Best precon for value:** Silverquill Influence (Land Tax reprint alone)
- **Sealed format:** Witherbloom's Infusion is the most forgiving mechanic (lifegain is natural), Lorehold's Flashback gives you card advantage (cast spells twice)

## Implementation Units

- [ ] **Unit 1: Write the research brief document**

  **Goal:** Produce a complete, beginner-friendly research brief at `docs/strixhaven-prerelease-brief.md`

  **Requirements:** R1, R2, R3, R4, R5, R6, R7

  **Dependencies:** None (research is complete in this plan)

  **Files:**
  - Create: `docs/strixhaven-prerelease-brief.md`

  **Approach:**
  - Structure with a TL;DR recommendation up top, then expand into detailed sections
  - Use tables for at-a-glance college comparisons
  - Include a "Sealed Deck Building 101" section for fundamentals
  - End with practical logistics (what to bring, what to expect)
  - Keep language accessible — explain MTG jargon inline where used

  **Patterns to follow:**
  - Conversational markdown document style
  - Progressive disclosure (summary first, detail below)

  **Test expectation:** none — this is a research document, not code

  **Verification:**
  - Document covers all 5 colleges with mechanics explained
  - Clear recommendation with reasoning
  - Sealed fundamentals section present
  - Commander precon comparison included
  - Readable by someone with 1 week of MTG experience

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Spoiler season still active — card evaluations may shift | Focus on mechanics and strategy principles rather than specific card picks |
| Prerelease format may vary by store (some run drafts too) | Cover both sealed fundamentals and note draft differences |

## Sources & References

- [Official Secrets of Strixhaven Mechanics](https://magic.wizards.com/en/news/feature/secrets-of-strixhaven-mechanics)
- [Where to Play Secrets of Strixhaven](https://magic.wizards.com/en/news/feature/where-to-play-secrets-of-strixhaven)
- [GameTyrant Comprehensive Guide](https://gametyrant.com/news/introducing-magic-the-gathering-secrets-of-strixhaven)
- [EDH Lab Commander Precon Rankings](https://blog.edhlab.gg/best-precons-ever-secrets-of-strixhaven-commander-decklists/)
- [Card Game Base Precon Decklists](https://cardgamebase.com/secrets-of-strixhaven-commander-precons-decklists/)
- [Star City Games Overview](https://articles.starcitygames.com/magic-the-gathering/everything-you-need-to-know-about-secrets-of-strixhaven/)
- [Ultimate Guard Prerelease Tips](https://ultimateguard.com/en/blog/magic-the-gathering-pre-release-tips-and-tricks)
