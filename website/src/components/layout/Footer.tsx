'use client';

import { Badge } from '@/components/ui/badge';
import { META, packages } from '@/lib/utils';
import { BookOpen, Github } from 'lucide-react';

const footerLinks: Record<string, { label: string; href: string }[]> = {
  Product: [
    { label: 'Features', href: '#features' },
    { label: 'Surfaces', href: '#interfaces' },
    { label: 'Architecture', href: '#architecture' },
    { label: 'Changelog', href: '#changelog' },
  ],
  Resources: [
    { label: 'README', href: `${META.repo}#readme` },
    { label: 'Full changelog', href: `${META.repo}/blob/main/CHANGELOG.md` },
    { label: 'Release process', href: `${META.repo}/blob/main/RELEASE.md` },
    { label: 'Docs', href: `${META.repo}/tree/main/docs` },
    { label: 'Security policy', href: `${META.repo}/blob/main/SECURITY.md` },
  ],
  Community: [
    { label: 'GitHub', href: META.repo },
    { label: 'Issues', href: `${META.repo}/issues` },
    { label: 'Discussions', href: `${META.repo}/discussions` },
    { label: 'Releases', href: `${META.repo}/releases` },
  ],
};

export function Footer() {
  return (
    <footer className="relative border-t border-line bg-surface/40">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <a href="#main" className="flex items-center gap-2.5">
              <span className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-2 font-mono text-sm font-bold text-white">
                ❯_
              </span>
              <span className="font-mono text-[17px] font-bold tracking-tight">
                wrong<span className="text-brand">stack</span>
              </span>
            </a>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
              Built on the wrong stack. Shipped anyway. A CLI AI coding agent that runs in your
              terminal.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge variant="outline" className="border-brand/30 text-brand">
                {META.license} License
              </Badge>
              <Badge variant="outline" className="border-brand-2/30 text-brand-2">
                Node.js {META.node}+
              </Badge>
            </div>
          </div>

          {/* Link columns */}
          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title}>
              <h4 className="text-sm font-semibold text-fg">{title}</h4>
              <ul className="mt-4 space-y-2.5">
                {links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      target={link.href.startsWith('#') ? undefined : '_blank'}
                      rel={link.href.startsWith('#') ? undefined : 'noopener noreferrer'}
                      className="text-sm text-muted transition-colors hover:text-brand"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Packages */}
        <div className="mt-12 border-t border-line pt-8">
          <h4 className="font-mono text-xs uppercase tracking-widest text-faint">
            Workspace packages
          </h4>
          <div className="mt-4 flex flex-wrap gap-2">
            {packages.map((pkg) => (
              <span
                key={pkg}
                className="rounded-md border border-line bg-card px-2.5 py-1 font-mono text-xs text-muted"
              >
                {pkg}
              </span>
            ))}
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-10 flex flex-col items-center justify-between gap-4 border-t border-line pt-8 text-sm text-muted sm:flex-row">
          <p>
            &copy; {new Date().getFullYear()} WrongStack · {META.license}
          </p>
          <div className="flex items-center gap-5">
            <a
              href={META.repo}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 transition-colors hover:text-brand"
            >
              <Github className="size-4" /> GitHub
            </a>
            <a
              href={`${META.repo}/tree/main/docs`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 transition-colors hover:text-brand"
            >
              <BookOpen className="size-4" /> Docs
            </a>
            <span className="flex items-center gap-1.5 font-mono">
              <span className="size-2 rounded-full bg-term-green shadow-[0_0_8px] shadow-emerald-500/60" />
              v{META.version}
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
