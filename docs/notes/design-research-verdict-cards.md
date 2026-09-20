# Design research (d) — verdict-first scannable data cards

**Bounded question:** what makes dense data cards scannable — is "verdict first" actually supported?

**Answer.** Yes, and it has independent support from writing research and from card research: lead with the conclusion (inverted pyramid), never with "blah-blah" positioning text; and for *choosing between options* — which is what Umbra's route options are — a predictably-positioned vertical list beats a layout of self-contained cards, because comparison needs each number at a fixed, anticipatable place.

**Verified (primary sources, accessed 2026-09-20):**

- NN/g, "Inverted Pyramid: Writing for Comprehension" (published 2018-02-11): "Start content with the most important piece of information ... readers can stop reading at any point and still come away with the main point"; supports skimmers and trims — https://www.nngroup.com/articles/inverted-pyramid/.
- NN/g, "Blah-Blah Text: Keep, Cut, or Kill?": users' eyes "go directly to more actionable content, such as product features, bulleted lists, or hypertext links"; "Kill the welcome mat and cut to the chase" — https://www.nngroup.com/articles/blah-blah-text-keep-cut-or-kill/.
- NN/g, "Cards: UI-Component Definition": "Card layouts are less scannable than lists ... the positioning of the individual elements is fixed in size and more predictable for the eye"; cards "are not appropriate when users search for a specific item from a list" and comparison in card grids is harder than a vertical list where "similar information would be located in predictable, consistent places" — https://www.nngroup.com/articles/cards-component/.
- GOV.UK summary list: a list "of key facts" as label/value rows (`dl`), with a summary-card variant that wraps a headed collection — the reference anatomy for a key-facts strip with one action — https://design-system.service.gov.uk/components/summary-list/.
- Undercover (shipped, 2026-02-03): route choice presented as shortest / most shaded / recommended with shade % as the headline figure — and measured: 95% of trial users chose the recommended blend when the trade-off was legible — https://www.hack.gov.sg/2026/undercover/.
- Apple HIG place cards: header (name, category, rating) + discrete tiles for hours and contact; compact vs full styles; "make sure enough contrast" and "avoid duplicating information" — https://developer.apple.com/design/human-interface-guidelines/maps.

**Inferred (synthesis).** Verdict-first anatomy that fits this evidence: eyebrow (what/why, e.g. "SHADED") → verdict in one sentence ("12 min, 84% shaded") → the three numbers as a fixed key/value strip in stable positions → provenance affordance as the footnote. The verdict and the numbers keep their columns across sibling options; personality lives in the eyebrow/chrome, never between the reader and the number. This is exactly TRACK_U P2/U3/U5.

**What this changes for Umbra.** U3 should present route options as a ranked list (or a sheet whose cards share one rigid grid), U5 rewrites headline-first with the province footnote, and the Undercover 95% datapoint justifies investing in making the trade-off line genuinely legible rather than decorative.
