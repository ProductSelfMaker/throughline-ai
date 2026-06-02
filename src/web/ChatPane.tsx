// src/web/ChatPane.tsx
import { useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchTranscript, sendChat, type Msg } from './api';

type Tool = { name: string; target: string };
type Turn = { role: 'user' | 'assistant'; content: string; tools: Tool[] };

export function ChatPane() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetchTranscript()
      .then((msgs: Msg[]) => { if (alive) setTurns(msgs.map((m) => ({ role: m.role, content: m.content, tools: [] }))); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [turns]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setTurns((t) => [...t, { role: 'user', content: text, tools: [] }, { role: 'assistant', content: '', tools: [] }]);
    setBusy(true);
    try {
      await sendChat(text, (ev) => {
        setTurns((t) => {
          const copy = t.slice();
          const last = copy[copy.length - 1];
          if (ev.type === 'text') copy[copy.length - 1] = { ...last, content: last.content + ev.text };
          else if (ev.type === 'tool') copy[copy.length - 1] = { ...last, tools: [...last.tools, { name: ev.name, target: ev.target }] };
          return copy;
        });
      });
    } catch {
      setTurns((t) => {
        const copy = t.slice();
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = { ...last, content: (last.content || '') + '\n\n_[오류가 발생했어요. 다시 시도해 주세요.]_' };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="chat">
      <header className="chat-head">💬 Claude Code</header>
      <div className="chat-log">
        {turns.length === 0 ? <p className="empty">무엇을 만들까요? 메시지를 입력해 시작하세요.</p> : null}
        {turns.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="msg-user">{m.content}</div>
          ) : (
            <div key={i} className="msg-asst">
              <div className="asst-label">✦ CLAUDE</div>
              {m.tools.map((t, j) => (
                <span key={j} className="tool-chip">🔧 <b>{t.name}</b>{t.target ? ` ${t.target}` : ''} <span className="chk">✓</span></span>
              ))}
              <div className="asst-md">
                {m.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown> : <span className="typing">작성 중…</span>}
              </div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={submit}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="메시지를 입력하세요…" disabled={busy} />
        <button disabled={busy} aria-label="보내기">↑</button>
      </form>
    </section>
  );
}
