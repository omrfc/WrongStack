// Verification harness (NOT shipped). Mounts the REAL ChatView with a seeded
// chat store so the virtua VList renders against real browser layout — letting
// a headless Chromium count how many message bubbles actually mount out of a
// large transcript. ChatView does not bootstrap the WebSocket (that lives in
// App), so mounting it standalone opens no socket.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ChatView } from '@/components/ChatView';
import { useChatStore, useSessionStore } from '@/stores';
import '@/index.css';
import '@/syntax-highlight.css';

const TOTAL = 300;
const store = useChatStore.getState();
const base = Date.now() - TOTAL * 60_000;
for (let i = 0; i < TOTAL; i++) {
  const role = i % 2 === 0 ? 'user' : 'assistant';
  store.addMessage({
    role,
    content:
      role === 'user'
        ? `User question ${i}: how does the virtualized list behave at scale?`
        : `Assistant answer ${i}.\n\nThis is a **markdown** paragraph with some length so each bubble has real height. ${'lorem ipsum dolor sit amet '.repeat(6)}`,
    timestamp: base + i * 60_000,
  });
}
// A session id makes ChatView treat this as a populated transcript.
useSessionStore.setState({ session: { id: 'verify-session', title: 'verify' } as never });

// Expose totals + a DOM counter for the Playwright driver to read.
(window as unknown as { __verify: unknown }).__verify = {
  total: TOTAL,
  mountedBubbles: () => document.querySelectorAll('[data-message-id]').length,
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="dark">
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <ChatView />
      </div>
    </ThemeProvider>
  </React.StrictMode>,
);
