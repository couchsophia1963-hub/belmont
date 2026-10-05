import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Share2, Copy, Check, Facebook, Twitter, Link as LinkIcon } from 'lucide-react';
import { storyShareUrl } from '@/lib/storyUrl';

interface ShareButtonProps {
  slug: string;
  title: string;
  variant?: 'default' | 'compact';
}

export function ShareButton({ slug, title, variant = 'default' }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The share URL is built from the slug, not from `window.location.pathname`
  // plus a hash. This button is also rendered on the homepage, where the
  // pathname is `/`, and under BrowserRouter (BEL-92) a story page's pathname
  // is already `/story/<slug>` — either way, reusing the current pathname
  // produced `/#/story/<slug>` or `/story/<slug>#/story/<slug>`.
  const shareUrl = storyShareUrl(slug, window.location.origin, window.location.pathname);
  const shareText = `${title} — Belmont County News`;

  useLayoutEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const menuWidth = variant === 'compact' ? 170 : 190;
      const left = Math.min(rect.left, window.innerWidth - menuWidth - 16);
      setMenuPos({ top: rect.bottom + 6, left: Math.max(8, left) });
    }
  }, [open, variant]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const copyLink = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    setOpen(false);
  };

  const handleShareClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (navigator.share) {
      navigator.share({ title, text: shareText, url: shareUrl }).catch(() => {});
    } else {
      setOpen((v) => !v);
    }
  };

  const openFacebook = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
      '_blank',
      'noopener,noreferrer,width=600,height=400'
    );
    setOpen(false);
  };

  const openTwitter = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`,
      '_blank',
      'noopener,noreferrer,width=600,height=400'
    );
    setOpen(false);
  };

  const menu = menuPos && (
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 9999 }}
      className="bg-white dark:bg-stone-800 rounded-lg shadow-xl border border-stone-200 dark:border-stone-600 py-1 min-w-[170px]"
    >
      <button onClick={openFacebook} className="w-full px-4 py-2 flex items-center gap-2 text-sm text-stone-700 dark:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-700 transition-colors">
        <Facebook className="w-4 h-4 text-[#1877f2]" />
        Facebook
      </button>
      <button onClick={openTwitter} className="w-full px-4 py-2 flex items-center gap-2 text-sm text-stone-700 dark:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-700 transition-colors">
        <Twitter className="w-4 h-4 text-stone-900 dark:text-stone-100" />
        Twitter / X
      </button>
      <button onClick={copyLink} className="w-full px-4 py-2 flex items-center gap-2 text-sm text-stone-700 dark:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-700 transition-colors">
        {copied ? <Check className="w-4 h-4 text-success-600" /> : <Copy className="w-4 h-4" />}
        {copied ? 'Copied!' : 'Copy Link'}
      </button>
    </div>
  );

  if (variant === 'compact') {
    return (
      <>
        <button
          ref={btnRef}
          onClick={handleShareClick}
          className="relative p-1.5 rounded-lg text-stone-400 hover:text-primary-700 dark:hover:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/30 transition-colors bg-white/80 dark:bg-stone-800/80 backdrop-blur-sm shadow-sm"
          title="Share"
        >
          <Share2 className="w-4 h-4" />
        </button>
        {open && menu}
      </>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleShareClick}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-sans text-sm font-bold text-primary-700 dark:text-primary-300 bg-primary-50 dark:bg-primary-900/30 hover:bg-primary-100 dark:hover:bg-primary-900/50 transition-colors"
      >
        <Share2 className="w-4 h-4" />
        Share
      </button>
      {open && menu}
    </>
  );
}
