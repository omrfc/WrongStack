'use client';

const names = [
  'Anthropic',
  'OpenAI',
  'Google',
  'Mistral',
  'Groq',
  'DeepSeek',
  'OpenRouter',
  'Together',
  'xAI',
  'Cerebras',
  'Ollama',
  'Fireworks',
  'Moonshot',
  'Perplexity',
  'MiniMax',
  'Kimi',
  'GLM',
  'Alibaba',
];

export function ProviderStrip() {
  return (
    <section aria-label="Supported providers" className="border-y border-line bg-surface/40 py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <p className="text-center font-mono text-xs uppercase tracking-widest text-faint">
          Talks to ~110 providers — refreshed from models.dev before boot completes
        </p>
        <div className="edge-fade mt-5 overflow-hidden">
          <div className="marquee flex w-max items-center gap-10">
            {['a', 'b'].flatMap((copy) =>
              names.map((name) => (
                <span
                  key={`${copy}-${name}`}
                  className="whitespace-nowrap text-lg font-semibold text-muted/70 transition-colors hover:text-fg"
                >
                  {name}
                </span>
              )),
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
