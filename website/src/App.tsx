'use client';

import { Footer } from '@/components/layout/Footer';
import { Header } from '@/components/layout/Header';
import { Architecture } from '@/components/sections/Architecture';
import { Changelog } from '@/components/sections/Changelog';
import { FAQ } from '@/components/sections/FAQ';
import { Features } from '@/components/sections/Features';
import { Hero } from '@/components/sections/Hero';
import { Install } from '@/components/sections/Install';
import { Interfaces } from '@/components/sections/Interfaces';
import { ProviderStrip } from '@/components/sections/ProviderStrip';
import { Release } from '@/components/sections/Release';
import { Security } from '@/components/sections/Security';
import { Skills } from '@/components/sections/Skills';
import { TUIDemo } from '@/components/sections/TUIDemo';
import { AnimatePresence, motion, useScroll, useSpring } from 'framer-motion';
import { ArrowUp } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Highlight the nav link for whichever section is in view. */
function useScrollSpy() {
  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>('section[id]');
    const links = document.querySelectorAll<HTMLAnchorElement>('a[data-nav]');
    const setActive = (id: string | null) => {
      for (const link of links) {
        const on = link.getAttribute('href') === `#${id}`;
        link.classList.toggle('text-fg', on);
        link.classList.toggle('text-muted', !on);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(visible.target.getAttribute('id'));
      },
      { threshold: [0.2, 0.5], rootMargin: '-30% 0px -55% 0px' },
    );
    for (const s of sections) observer.observe(s);
    return () => observer.disconnect();
  }, []);
}

function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 120,
    damping: 30,
    mass: 0.2,
  });
  return (
    <motion.div
      style={{ scaleX }}
      className="fixed inset-x-0 top-0 z-[60] h-0.5 origin-left bg-gradient-to-r from-brand via-brand-2 to-brand"
      aria-hidden
    />
  );
}

function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 600);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <AnimatePresence>
      {show && (
        <motion.button
          aria-label="Back to top"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          initial={{ opacity: 0, scale: 0.8, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.8, y: 12 }}
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.94 }}
          className="fixed bottom-6 right-6 z-50 grid size-11 place-items-center rounded-full border border-line bg-surface/90 text-fg shadow-lg backdrop-blur transition-colors hover:border-brand/50 hover:text-brand"
        >
          <ArrowUp className="size-5" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

export default function App() {
  useScrollSpy();

  return (
    <div className="min-h-screen bg-bg text-fg antialiased">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <ScrollProgress />
      <Header />

      <main id="main">
        <Hero />
        <ProviderStrip />
        <Features />
        <Interfaces />
        <Architecture />
        <TUIDemo />
        <Skills />
        <Security />
        <Changelog />
        <Release />
        <FAQ />
        <Install />
      </main>

      <Footer />
      <BackToTop />
    </div>
  );
}
