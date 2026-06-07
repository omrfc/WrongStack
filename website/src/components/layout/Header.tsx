'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { META } from '@/lib/utils';
import { AnimatePresence, motion } from 'framer-motion';
import { Github, Menu, Moon, Sun, X } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

const navItems = [
  { href: '#features', label: 'Features' },
  { href: '#interfaces', label: 'Surfaces' },
  { href: '#architecture', label: 'Architecture' },
  { href: '#demo', label: 'Demo' },
  { href: '#skills', label: 'Skills' },
  { href: '#security', label: 'Security' },
  { href: '#changelog', label: 'Changelog' },
  { href: '#release', label: 'Release' },
];

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="text-muted hover:text-fg"
    >
      {mounted ? (
        isDark ? (
          <Sun className="size-5" />
        ) : (
          <Moon className="size-5" />
        )
      ) : (
        <span className="size-5" />
      )}
    </Button>
  );
}

export function Header() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 transition-colors duration-300',
        scrolled ? 'border-b border-line bg-bg/80 backdrop-blur-xl' : 'border-b border-transparent',
      )}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <a href="#main" className="group flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-2 font-mono text-sm font-bold text-white shadow-sm shadow-brand/30 transition-transform group-hover:-rotate-3">
            ❯_
          </span>
          <span className="font-mono text-[17px] font-bold tracking-tight">
            wrong<span className="text-brand">stack</span>
          </span>
        </a>

        {/* Desktop nav */}
        <div className="hidden items-center gap-1 md:flex">
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              data-nav
              className="rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-fg"
            >
              {item.label}
            </a>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Button variant="ghost" size="icon" asChild className="text-muted hover:text-fg">
            <a
              href={META.repo}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub repository"
            >
              <Github className="size-5" />
            </a>
          </Button>
          <Button size="sm" asChild className="ml-1 hidden sm:inline-flex">
            <a href="#install">Get started</a>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Menu"
            className="md:hidden"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </Button>
        </div>
      </nav>

      {/* Mobile menu */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden border-b border-line bg-bg/95 backdrop-blur-xl md:hidden"
          >
            <div className="space-y-1 px-4 py-4">
              {navItems.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-sm font-medium text-muted hover:bg-surface hover:text-fg"
                >
                  {item.label}
                </a>
              ))}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  document.getElementById('install')?.scrollIntoView({ behavior: 'smooth' });
                }}
                className="mt-2 block w-full rounded-lg bg-gradient-to-r from-brand to-brand-strong px-3 py-2.5 text-center text-sm font-semibold text-white"
              >
                Get started
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
