/**
 * The shelter correction notice (BEL-310).
 *
 * This is frontend chrome, rendered by `HomePage` and `StoryDetailPage` from this
 * module. It is NOT written into the `stories` table and must not be: writing
 * this text into story `2872752e` is a `stories update`, which is not approved
 * and stays that way.
 *
 * The wording was approved by Mara Vance on BEL-303 at 17:44:56Z and is hers. It
 * is hers to change, not ours. It lives in one file because the same byline and
 * the same URL are rendered in two places, and a notice that disagrees with
 * itself about where the accurate story is reads as two corrections rather than
 * one.
 *
 * Presentation -- placement, prominence, whether it is dated or dismissible -- is
 * Tobias's call on the rendered result. The only gate either page applies is the
 * slug match below.
 */

export const SHELTER_BIDS_CORRECTED_SLUG = 'belmont-county-new-animal-shelter-bids';

export const SHELTER_BIDS_ACCURATE_STORY_URL =
  'https://easyschedule.github.io/belmont-news-site/2026-10-05/belmont-county-animal-shelter-bids-due-october-14/';

export const SHELTER_BIDS_AUTHOR = 'Dev Okafor';

/**
 * The front page line, verbatim and as one line.
 *
 * The backticks around the URL in the approved text are the ticket's Markdown,
 * not characters a reader sees. The URL is a separate string here so both pages
 * can link it; `shelterCorrection.test.ts` asserts this concatenation is exactly
 * the approved sentence.
 */
export const SHELTER_BIDS_FRONT_PAGE_TEXT =
  'Correction: the animal shelter bids item on this page is not Belmont News ' +
  'reporting and is superseded. The accurate story, by ' +
  `${SHELTER_BIDS_AUTHOR}: ${SHELTER_BIDS_ACCURATE_STORY_URL}`;

/** The lead word. The ticket bolds this and nothing else in the story-page copy. */
export const SHELTER_BIDS_LEAD = 'Correction.';

/**
 * The story-page notice body, split around the URL so the page can link it.
 *
 * `SHELTER_BIDS_STORY_PAGE_TEXT` is the three parts joined, and it is what the
 * test asserts the rendered page against. Reordering or trimming a part here
 * fails that test rather than shipping a reworded correction.
 */
export const SHELTER_BIDS_STORY_PAGE_LEAD_IN =
  'The animal shelter bids item on this page is not Belmont News reporting. ' +
  'It was published here without a byline or a credit line, it says the bid ' +
  'window has closed when the deadline is 11:15 a.m. on Wednesday 14 October ' +
  '2026, and it misquotes Commissioner Jerry Echemann. It is superseded and ' +
  'should not be relied on. The accurate Belmont News story, by ' +
  `${SHELTER_BIDS_AUTHOR}, is at `;

export const SHELTER_BIDS_STORY_PAGE_LEAD_OUT = '. Belmont News apologises for the error.';

/**
 * The whole story-page notice as one string: bold lead word, body, URL.
 *
 * This is what the test asserts the rendered page against. The page renders the
 * parts above, because the URL has to be a link; this is the same sentence with
 * nothing split out, so the two cannot drift apart silently.
 */
export const SHELTER_BIDS_STORY_PAGE_TEXT = `${SHELTER_BIDS_LEAD} ${SHELTER_BIDS_STORY_PAGE_LEAD_IN}${SHELTER_BIDS_ACCURATE_STORY_URL}${SHELTER_BIDS_STORY_PAGE_LEAD_OUT}`;

export const SHELTER_BIDS_ATTRIBUTION = '\u2014 Belmont News, 5 October 2026';

/** True when `slug` is the item this notice corrects. The only gate either page uses. */
export function isShelterBidsCorrectedStory(slug: string | undefined): boolean {
  return slug === SHELTER_BIDS_CORRECTED_SLUG;
}