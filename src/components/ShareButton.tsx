import { useState, useRef, useEffect } from 'react';
import { Share2, Copy, Check, Facebook, Twitter, Link as LinkIcon } from 'lucide-react';

interface ShareButtonProps {
  slug: string;
  title: string;
  variant?: 'default' | 'compact';
}

export function ShareButton({ slug, title, variant = 'default' }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const shareUrl = `${window.location.origin}${window.location.pathname}#/story/${slug}`;
  const shareText = `${title} — Belmont County News`;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
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
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const nativeShare = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (navigator.share) {
      try {
        await navigator.share({ title, text: shareText, url: shareUrl });
      } catch {
        // user cancelled
      }
    } else {
      setOpen(!open);
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

  if (variant === 'compact') {
    return (
      <div ref={ref} className="relative inline-block">
        <button
          onClick={nativeShare}
          className="p-1.5 rounded-lg text-stone-400 hover:text-primary-700 hover:bg-primary-50 transition-colors"
          title="Share"
        >
          <Share2 className="w-4 h-4" />
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-lg shadow-xl border border-stone-200 py-1 min-w-[160px]">
            <button onClick={openFacebook} className="w-full px-4 py-2 flex items-center gap-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors">
              <Facebook className="w-4 h-4 text-[#1877f2]" />
              Facebook
            </button>
            <button onClick={openTwitter} className="w-full px-4 py-2 flex items-center gap-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors">
              <Twitter className="w-4 h-4 text-stone-900" />
              Twitter / X
            </button>
            <button onClick={copyLink} className="w-full px-4 py-2 flex items-center gap-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors">
              {copied ? <Check className="w-4 h-4 text-success-600" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied!' : 'Copy Link'}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={nativeShare}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-sans text-sm font-bold text-primary-700 bg-primary-50 hover:bg-primary-100 transition-colors"
      >
        <Share2 className="w-4 h-4" />
        Share
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-lg shadow-xl border border-stone-200 py-1 min-w-[180px]">
          <button onClick={openFacebook} className="w-full px-4 py-2.5 flex items-center gap-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-50 transition-colors">
            <Facebook className="w-4 h-4 text-[#1877f2]" />
            Share on Facebook
          </button>
          <button onClick={openTwitter} className="w-full px-4 py-2.5 flex items-center gap-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-50 transition-colors">
            <Twitter className="w-4 h-4 text-stone-900" />
            Share on Twitter / X
          </button>
          <div className="border-t border-stone-100 my-1" />
          <button onClick={copyLink} className="w-full px-4 py-2.5 flex items-center gap-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-50 transition-colors">
            {copied ? <Check className="w-4 h-4 text-success-600" /> : <LinkIcon className="w-4 h-4" />}
            {copied ? 'Link Copied!' : 'Copy Link'}
          </button>
        </div>
      )}
    </div>
  );
}
