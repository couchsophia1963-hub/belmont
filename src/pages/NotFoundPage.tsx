import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, FileQuestion } from 'lucide-react';

/**
 * The catch-all route (BEL-92).
 *
 * A mistyped or retired path used to render the homepage, so a broken link
 * looked exactly like the front page and a reader had no way to tell the story
 * they asked for was never delivered. This page says what happened and offers a
 * way out.
 *
 * The HTTP status is a separate matter and is not 404 on this host. The Bolt
 * host answers every path with `index.html` and a 200, so a client-side route
 * cannot change the status. Fixing that needs a host-level rule (answer
 * unknown paths with a 404), which is deploy work, not a component. The title
 * and the visible text are set here so a reader and a crawler that renders
 * JavaScript both see the miss.
 */
export function NotFoundPage() {
  const location = useLocation();

  // Restore whatever title the previous page left behind. Without the cleanup
  // this effect set the title once and never took it back, so a reader who hit
  // one bad link kept seeing "Page not found" in the tab for the rest of the
  // session, including back on the homepage. No other page sets a title, so in
  // practice this restores the one in index.html.
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Page not found — Belmont County News';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-24 text-center">
      <div className="inline-flex w-16 h-16 rounded-2xl bg-primary-700 items-center justify-center mb-6 shadow-lg">
        <FileQuestion className="w-8 h-8 text-white" />
      </div>

      <p className="font-sans text-sm font-bold uppercase tracking-wider text-primary-600 mb-2">
        404
      </p>
      <h1 className="font-serif text-3xl sm:text-4xl font-black text-stone-900 leading-tight mb-4">
        We could not find that page
      </h1>
      <p className="font-sans text-lg text-stone-600 leading-relaxed mb-2">
        The address <code className="font-mono text-base text-stone-800 break-all">{location.pathname}</code>{' '}
        does not match a page on this site.
      </p>
      <p className="font-sans text-base text-stone-500 mb-8">
        If you followed a link to a story, the link may be old or mistyped. The latest stories are on the front page.
      </p>

      <Link
        to="/"
        className="inline-flex items-center gap-2 font-sans text-sm font-bold text-primary-700 hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Home
      </Link>
    </div>
  );
}
