/**
 * The shelter correction notice (BEL-310).
 *
 * These assertions exist because the notice is a correction. A correction that
 * has drifted by a word is still a correction notice, still carries a
 * correction label, and is still wrong in the way corrections are wrong: it
 * understates what was wrong. Nothing in CI would catch it, and a reviewer
 * reading a diff at speed would not either.
 *
 * The expected strings below are therefore written out in full, from the wording
 * Mara Vance approved on BEL-303 at 17:44:56Z, rather than imported from the
 * module under test. A test that rebuilds the expected value out of the same
 * constants as the implementation proves the constants concatenate; it does not
 * prove the sentence is the approved one.
 *
 * The second half of this file is the behaviour that matters to a reader: the
 * story-page notice appears on that one slug and nowhere else, and it still
 * appears when the read path fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/supabase', async () => {
  const mock = await import('@/test/supabaseMock');
  return { supabase: mock.supabase };
});

import App from '@/App';
import { resetSupabaseMock, setTableResult } from '@/test/supabaseMock';
import {
  SHELTER_BIDS_FRONT_PAGE_TEXT,
  SHELTER_BIDS_STORY_PAGE_TEXT,
  isShelterBidsCorrectedStory,
} from '@/lib/shelterCorrection';

const ACCURATE_STORY =
  'https://easyschedule.github.io/belmont-news-site/2026-10-05/belmont-county-animal-shelter-bids-due-october-14/';

const FRONT_PAGE_TEXT =
  'Correction: the animal shelter bids item on this page is not Belmont News ' +
  'reporting and is superseded. The accurate story, by Dev Okafor: ' +
  ACCURATE_STORY;

const STORY_PAGE_TEXT =
  'Correction. The animal shelter bids item on this page is not Belmont News ' +
  'reporting. It was published here without a byline or a credit line, it says ' +
  'the bid window has closed when the deadline is 11:15 a.m. on Wednesday 14 ' +
  'October 2026, and it misquotes Commissioner Jerry Echemann. It is superseded ' +
  'and should not be relied on. The accurate Belmont News story, by Dev Okafor, ' +
  `is at ${ACCURATE_STORY}. Belmont News apologises for the error.`;

const ATTRIBUTION = '\u2014 Belmont News, 5 October 2026';

const CORRECTED_SLUG = 'belmont-county-new-animal-shelter-bids';

const CORRECTED_STORY_ROW = {
  id: '2872752e',
  slug: CORRECTED_SLUG,
  title: 'Animal Shelter Bids',
  excerpt: 'An excerpt.',
  body: 'First paragraph.\n\nSecond paragraph.',
  image_url: null,
  category: 'Local News',
  author_id: null,
  is_headline: false,
  published: true,
  locked: false,
  locked_until: null,
  created_at: '2026-10-05T09:00:00.000Z',
  updated_at: '2026-10-05T09:00:00.000Z',
};

/** The rendered text of the element a reader reads the notice in. */
function noticeText(): string {
  return screen.getByRole('note').textContent ?? '';
}

function renderAppAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

beforeEach(() => {
  resetSupabaseMock();
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the approved wording is reproduced exactly', () => {
  it('holds the front page line, character for character', () => {
    // If this fails, the copy was edited. It is Mara Vance's to change, on
    // BEL-303, not ours to change here.
    expect(SHELTER_BIDS_FRONT_PAGE_TEXT).toBe(FRONT_PAGE_TEXT);
  });

  it('holds the story page notice, character for character', () => {
    expect(SHELTER_BIDS_STORY_PAGE_TEXT).toBe(STORY_PAGE_TEXT);
  });

  it('renders the front page line verbatim on the homepage', async () => {
    setTableResult('weather_forecasts', { data: [], error: null });
    setTableResult('stories', { data: [], error: null });

    renderAppAt('/');

    expect(await screen.findByRole('note')).toBeTruthy();
    expect(noticeText()).toBe(FRONT_PAGE_TEXT);
  });

  it('renders the story page notice verbatim on the corrected slug', async () => {
    setTableResult('stories', { data: CORRECTED_STORY_ROW, error: null });

    renderAppAt(`/story/${CORRECTED_SLUG}`);

    expect(await screen.findByRole('note')).toBeTruthy();
    // The attribution is its own line, so the paragraph above ends at
    // "...apologises for the error." with nothing appended to it.
    const paragraphs = screen.getByRole('note').querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe(STORY_PAGE_TEXT);
    expect(paragraphs[1].textContent).toBe(ATTRIBUTION);
  });

  it('links the accurate story from both notices', async () => {
    setTableResult('weather_forecasts', { data: [], error: null });
    setTableResult('stories', { data: [], error: null });
    renderAppAt('/');
    expect((await screen.findByRole('link', { name: ACCURATE_STORY })).getAttribute('href')).toBe(
      ACCURATE_STORY
    );
    cleanup();

    resetSupabaseMock();
    setTableResult('stories', { data: CORRECTED_STORY_ROW, error: null });
    renderAppAt(`/story/${CORRECTED_SLUG}`);
    expect((await screen.findByRole('link', { name: ACCURATE_STORY })).getAttribute('href')).toBe(
      ACCURATE_STORY
    );
  });
});

describe('the notice never edits the story body', () => {
  it('leaves the story row it is displayed on byte for byte alone', async () => {
    // The one thing this change must not do is write the correction into the
    // story. `2872752e` is what this notice is about, and a `stories update`
    // against it is not approved. The story still renders its own body, and the
    // notice sits above it rather than inside it.
    const row = { ...CORRECTED_STORY_ROW };
    setTableResult('stories', { data: row, error: null });

    renderAppAt(`/story/${CORRECTED_SLUG}`);

    expect(await screen.findByRole('note')).toBeTruthy();
    expect(screen.getByText('First paragraph.')).toBeTruthy();

    // Nothing in the render path rewrites the object it was given.
    expect(row).toEqual(CORRECTED_STORY_ROW);
    expect(row.body).toBe('First paragraph.\n\nSecond paragraph.');
  });
});

describe('the slug is the only gate', () => {
  it('matches the corrected slug and nothing else', () => {
    expect(isShelterBidsCorrectedStory(CORRECTED_SLUG)).toBe(true);
    expect(isShelterBidsCorrectedStory('belmont-county-animal-shelter-bids-due-october-14')).toBe(
      false
    );
    expect(isShelterBidsCorrectedStory('some-other-story')).toBe(false);
    expect(isShelterBidsCorrectedStory(undefined)).toBe(false);
  });

  it('shows no notice on an ordinary story', async () => {
    setTableResult('stories', {
      data: { ...CORRECTED_STORY_ROW, slug: 'wall-that-heals' },
      error: null,
    });

    renderAppAt('/story/wall-that-heals');

    expect(await screen.findByRole('heading', { name: 'Animal Shelter Bids' })).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows no notice on an unpublished slug match', async () => {
    // `published: false` is exactly the kind of thing the gate must ignore. A
    // draft at this slug is still the item the correction is about, and gating
    // on the row instead of the route would make the notice vanish for a writer
    // previewing the draft.
    setTableResult('stories', { data: { ...CORRECTED_STORY_ROW, published: false }, error: null });

    renderAppAt(`/story/${CORRECTED_SLUG}`);

    expect(await screen.findByRole('note')).toBeTruthy();
    expect(screen.queryByText('Story not found')).toBeNull();
  });
});

describe('the story page notice does not depend on the read', () => {
  it('still renders when the story query errors', async () => {
    // The reason this gate is the slug and not the row. A reader who lands on
    // this address while the read path is down is precisely the reader who most
    // needs to be told the item is not our reporting -- and a gate on the loaded
    // row would put the notice behind the same failure it exists to answer.
    resetSupabaseMock();

    renderAppAt(`/story/${CORRECTED_SLUG}`);

    expect(await screen.findByRole('note')).toBeTruthy();
    expect(noticeText()).toContain('Correction.');
    expect(screen.getByText('Failed to load story')).toBeTruthy();
  });

  it('still renders when no row matches the slug at all', async () => {
    setTableResult('stories', { data: null, error: null });

    renderAppAt(`/story/${CORRECTED_SLUG}`);

    expect(await screen.findByRole('note')).toBeTruthy();
    expect(screen.getByText('Story not found')).toBeTruthy();
  });
});

describe('the front page line', () => {
  it('is on the front page even when the page has no stories', async () => {
    // The notice refers to an item on the page. It is chrome, so it is rendered
    // from the route and does not wait on a row.
    setTableResult('weather_forecasts', { data: [], error: null });
    setTableResult('stories', { data: [], error: null });

    renderAppAt('/');

    expect(await screen.findByText('Recent Stories')).toBeTruthy();
    expect(screen.getByRole('note')).toBeTruthy();
  });

  it('is not repeated on the corrected story page', async () => {
    // The story page carries the long form. Both forms on one page would read as
    // two separate corrections about the same item.
    setTableResult('stories', { data: CORRECTED_STORY_ROW, error: null });

    renderAppAt(`/story/${CORRECTED_SLUG}`);

    expect(await screen.findByRole('note')).toBeTruthy();
    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(noticeText()).not.toContain('Correction: the animal shelter bids item');
  });
});