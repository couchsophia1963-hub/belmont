/**
 * Hero image alt text, decided per image.
 *
 * Issue: BEL-94. All four hero images set `alt={story.title}`, so a screen
 * reader heard the headline twice: once as the `<h1>`, once as the image
 * description. The second announcement described nothing about the photograph.
 *
 * The headline is the adjacent text. An image whose only available description
 * would be that adjacent text is decorative, and a decorative image takes
 * `alt=""`: silence is correct, a repeat of the line above is not.
 *
 * Every entry below was written after looking at the photograph, not derived
 * from the headline. Where the stock photo does not depict the story it is
 * attached to, describing it would be accurate about the picture and
 * misleading about the story, so it is decorative and absent from this table.
 *
 * No database access is required or implied. These are editorial decisions,
 * held in code, and adding a story needs no migration and no deploy ordering:
 * a story missing from the table is decorative, which is the safe default.
 */
const HERO_IMAGE_ALT: Record<string, string> = {
  // The photo shows the pumpkin patch itself at dusk with two people picking,
  // which the wrap-up headline does not say.
  'barnesville-pumpkin-festival-2026-wrap-up':
    'Rows of orange and white pumpkins in a field at dusk, with two people picking.',

  // The photo shows shelter dogs behind kennel fencing. The headline reports the
  // bidding process; the animals are the part it does not carry.
  'belmont-county-new-animal-shelter-bids':
    'Dogs standing behind chain-link kennel fencing at an animal shelter.',

  // The photo shows the game itself, two high school teams at the line of
  // scrimmage, which the record headline does not show.
  'martins-ferry-undefeated-buckeye-local':
    'Two high school football teams lined up at the line of scrimmage, one in orange helmets.',

  // The photo shows engraved names on a memorial wall with a rose laid on it.
  // This is the subject of the story and no restatement of the headline comes
  // near it.
  'wall-that-heals-belmont-county-fairgrounds':
    'A white rose laid on a dark memorial wall covered in engraved names.',
};

/**
 * The alt text for a story's hero image.
 *
 * Returns `""` for any story not listed above, which is the decorative default
 * and the behaviour that fixes BEL-94. It never falls back to `title`.
 */
export function heroImageAlt(story: { slug?: string | null }): string {
  const slug = story.slug;
  if (!slug) return '';
  return HERO_IMAGE_ALT[slug] ?? '';
}