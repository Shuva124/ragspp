import { useState, useRef, useEffect, useCallback } from "react";
import {
  Upload, Trash2, Send, FileText, Bot, User, Loader2,
  Database, MessageSquare, Zap, ChevronRight, X, CheckCircle,
  AlertCircle, File, Moon, Sun
} from "lucide-react";

// ── Config ──────────────────────────────────────────────────────────────────
const API = "https://ragspp.onrender.com";

// ── Markdown renderer (no external deps) ────────────────────────────────────
function renderMarkdown(text) {
  // Code blocks
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre class="code-block"><code class="lang-${lang}">${escHtml(code.trim())}</code></pre>`
  );
  // Inline code
  text = text.replace(/`([^`]+)`/g, (_, c) => `<code class="inline-code">${escHtml(c)}</code>`);
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Headings
  text = text.replace(/^### (.+)$/gm, "<h3 class='md-h3'>$1</h3>");
  text = text.replace(/^## (.+)$/gm, "<h2 class='md-h2'>$1</h2>");
  text = text.replace(/^# (.+)$/gm, "<h1 class='md-h1'>$1</h1>");
  // Unordered lists
  text = text.replace(/^\s*[-*] (.+)$/gm, "<li class='md-li'>$1</li>");
  text = text.replace(/(<li[\s\S]*?<\/li>)/g, "<ul class='md-ul'>$1</ul>");
  // Ordered lists
  text = text.replace(/^\d+\. (.+)$/gm, "<li class='md-oli'>$1</li>");
  // Horizontal rules
  text = text.replace(/^---$/gm, "<hr class='md-hr'/>");
  // Paragraphs
  text = text.replace(/\n\n/g, "</p><p class='md-p'>");
  return `<p class='md-p'>${text}</p>`;
}
function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Toast ────────────────────────────────────────────────────────────────────
function Toast({ toasts }) {
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.type === "success" ? <CheckCircle size={16}/> : <AlertCircle size={16}/>}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

// ── Typing indicator ─────────────────────────────────────────────────────────
function TypingIndicator({ phase }) {
  return (
    <div className="msg msg-ai">
      <div className="msg-avatar ai-avatar"><Bot size={16}/></div>
      <div className="msg-bubble ai-bubble typing-bubble">
        <span className="typing-phase">{phase}</span>
        <span className="typing-dots">
          <span/><span/><span/>
        </span>
      </div>
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [docs, setDocs]             = useState([]);
  const [messages, setMessages]     = useState([
    { role: "ai", content: "Hello! Upload documents using the sidebar, then ask me anything about their contents. I'll retrieve the most relevant context and answer precisely." }
  ]);
  const [input, setInput]           = useState("");
  const [uploading, setUploading]   = useState(false);
  const [streaming, setStreaming]   = useState(false);
  const [streamPhase, setStreamPhase] = useState("Thinking");
  const [toasts, setToasts]         = useState([]);
  const [dragOver, setDragOver]     = useState(false);
  const [dark, setDark]             = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const fileInputRef  = useRef();
  const chatEndRef    = useRef();
  const abortRef      = useRef(null);
  const toastId       = useRef(0);

  // Scroll to bottom on new message
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Fetch docs on mount
  useEffect(() => { fetchDocs(); }, []);

  const addToast = useCallback((message, type = "success") => {
    const id = ++toastId.current;
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3500);
  }, []);

  async function fetchDocs() {
    try {
      const res = await fetch(`${API}/documents`);
      const data = await res.json();
      setDocs(data.documents || []);
    } catch { /* backend not started yet */ }
  }

  async function handleUpload(files) {
    if (!files?.length) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res  = await fetch(`${API}/upload`, { method: "POST", body: fd });
        const data = await res.json();
        if (res.ok) {
          addToast(`✓ ${file.name} — ${data.chunks} chunks indexed`);
        } else {
          addToast(data.detail || "Upload failed", "error");
        }
      } catch {
        addToast(`Failed to upload ${file.name}`, "error");
      }
    }
    await fetchDocs();
    setUploading(false);
  }

  async function deleteDoc(id) {
    try {
      await fetch(`${API}/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
      addToast(`Document removed`);
      setDocs(p => p.filter(d => d.id !== id));
    } catch {
      addToast("Delete failed", "error");
    }
  }

  async function sendMessage() {
    const query = input.trim();
    if (!query || streaming) return;
    setInput("");
    setMessages(p => [...p, { role: "user", content: query }]);
    setStreaming(true);
    setStreamPhase("Retrieving context");

    // Placeholder for streaming AI message
    const aiId = Date.now();
    setMessages(p => [...p, { role: "ai", content: "", id: aiId, streaming: true }]);

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Server error");
      }

      // ── Stream processing ──────────────────────────────────────────────────
      // The backend sends plain text/event-stream chunks. We use a ReadableStream
      // reader to consume them incrementally. Each decoded chunk is appended to
      // the message content, triggering a React re-render so the text "types out"
      // word by word in the UI.
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   full    = "";

      setStreamPhase("Generating answer");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        full += chunk;
        // Update the AI placeholder message in-place
        setMessages(p =>
          p.map(m => m.id === aiId ? { ...m, content: full } : m)
        );
      }

      // Mark message as complete
      setMessages(p => p.map(m => m.id === aiId ? { ...m, streaming: false } : m));

    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages(p => p.map(m =>
          m.id === aiId
            ? { ...m, content: `⚠️ Error: ${err.message}`, streaming: false }
            : m
        ));
        addToast(err.message, "error");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function formatBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
    return `${(b/1048576).toFixed(1)} MB`;
  }

  return (
    <div className={`app ${dark ? "dark" : "light"}`}>
      <style>{styles}</style>
      <Toast toasts={toasts}/>

      {/* ── Top bar ── */}
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-btn" onClick={() => setSidebarOpen(p => !p)}>
            <ChevronRight size={18} style={{ transform: sidebarOpen ? "rotate(180deg)" : "", transition: "transform .3s" }}/>
          </button>
          <div className="logo">
            <Zap size={20} className="logo-icon"/>
            <span className="logo-text">RAG<em>Studio</em></span>
          </div>
        </div>
        <div className="topbar-right">
          <span className="status-pill">
            <span className="status-dot"/>
            {docs.length} doc{docs.length !== 1 ? "s" : ""} indexed
          </span>
          <button className="icon-btn" onClick={() => setDark(p => !p)}>
            {dark ? <Sun size={18}/> : <Moon size={18}/>}
          </button>
        </div>
      </header>

      <div className="workspace">
        {/* ── Sidebar ── */}
        <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
          <div className="sidebar-section">
            <div className="section-header">
              <Database size={14}/>
              <span>Document Index</span>
            </div>

            {/* Upload zone */}
            <div
              className={`drop-zone ${dragOver ? "drag-active" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); handleUpload(e.dataTransfer.files); }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.txt,.md,.docx"
                style={{ display: "none" }}
                onChange={e => handleUpload(e.target.files)}
              />
              {uploading
                ? <><Loader2 size={22} className="spin"/><span>Indexing…</span></>
                : <><Upload size={22}/><span>Drop files or click</span><small>.pdf · .txt · .md · .docx</small></>
              }
            </div>

            {/* Doc list */}
            <div className="doc-list">
              {docs.length === 0
                ? <p className="empty-hint">No documents yet</p>
                : docs.map(d => (
                  <div key={d.id} className="doc-item">
                    <div className="doc-icon"><File size={14}/></div>
                    <div className="doc-info">
                      <span className="doc-name" title={d.name}>{d.name}</span>
                      <span className="doc-meta">{d.chunks} chunks · {formatBytes(d.size)}</span>
                    </div>
                    <button className="del-btn" onClick={() => deleteDoc(d.id)}>
                      <Trash2 size={13}/>
                    </button>
                  </div>
                ))
              }
            </div>
          </div>
        </aside>

        {/* ── Chat area ── */}
        <main className="chat-area">
          <div className="chat-header">
            <MessageSquare size={16}/>
            <span>Chat</span>
          </div>

          <div className="messages">
            {messages.map((m, i) => (
              <div key={i} className={`msg msg-${m.role}`}>
                <div className={`msg-avatar ${m.role}-avatar`}>
                  {m.role === "ai" ? <Bot size={15}/> : <User size={15}/>}
                </div>
                <div className={`msg-bubble ${m.role}-bubble`}>
                  {m.role === "ai"
                    ? <div
                        className="markdown"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                      />
                    : <p>{m.content}</p>
                  }
                  {m.streaming && <span className="cursor-blink"/>}
                </div>
              </div>
            ))}

            {streaming && messages[messages.length - 1]?.content === "" && (
              <TypingIndicator phase={streamPhase}/>
            )}

            <div ref={chatEndRef}/>
          </div>

          <div className="input-bar">
            <textarea
              className="chat-input"
              rows={1}
              placeholder="Ask anything about your documents…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={streaming}
            />
            {streaming
              ? <button className="send-btn abort-btn" onClick={() => abortRef.current?.abort()}>
                  <X size={18}/>
                </button>
              : <button className="send-btn" onClick={sendMessage} disabled={!input.trim()}>
                  <Send size={18}/>
                </button>
            }
          </div>
        </main>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* Tokens */
  .dark  { --bg: #0c0e14; --surface: #13161f; --border: #1f2333; --text: #e2e8f0; --muted: #64748b; --accent: #6366f1; --accent2: #22d3ee; --ai-bg: #181c2a; --user-bg: #1e2235; --input-bg: #181c2a; }
  .light { --bg: #f1f5f9; --surface: #ffffff; --border: #e2e8f0; --text: #0f172a; --muted: #94a3b8; --accent: #6366f1; --accent2: #06b6d4; --ai-bg: #f8fafc; --user-bg: #eef2ff; --input-bg: #ffffff; }

  body { font-family: 'Syne', sans-serif; }

  .app { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text); overflow: hidden; }

  /* Topbar */
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 0 20px; height: 56px; background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .topbar-left, .topbar-right { display: flex; align-items: center; gap: 12px; }
  .logo { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 800; letter-spacing: -0.5px; }
  .logo em { color: var(--accent); font-style: normal; }
  .logo-icon { color: var(--accent); }
  .icon-btn { background: none; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); cursor: pointer; padding: 6px; display: flex; align-items: center; transition: all .2s; }
  .icon-btn:hover { color: var(--text); border-color: var(--accent); }
  .status-pill { display: flex; align-items: center; gap: 6px; font-size: 12px; font-family: 'IBM Plex Mono', monospace; color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: 20px; padding: 4px 12px; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

  /* Workspace */
  .workspace { display: flex; flex: 1; overflow: hidden; }

  /* Sidebar */
  .sidebar { background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; transition: width .3s; overflow: hidden; }
  .sidebar.open  { width: 300px; min-width: 300px; }
  .sidebar.closed{ width: 0; min-width: 0; }
  .sidebar-section { padding: 20px; display: flex; flex-direction: column; gap: 14px; min-width: 260px; }
  .section-header { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--muted); }

  /* Drop zone */
  .drop-zone { border: 2px dashed var(--border); border-radius: 12px; padding: 24px 16px; display: flex; flex-direction: column; align-items: center; gap: 8px; cursor: pointer; transition: all .25s; color: var(--muted); font-size: 13px; text-align: center; }
  .drop-zone small { font-family: 'IBM Plex Mono', monospace; font-size: 11px; opacity: .7; }
  .drop-zone:hover, .drag-active { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 5%, transparent); }

  /* Doc list */
  .doc-list { display: flex; flex-direction: column; gap: 8px; max-height: calc(100vh - 280px); overflow-y: auto; }
  .doc-list::-webkit-scrollbar { width: 4px; }
  .doc-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  .empty-hint { font-size: 12px; color: var(--muted); text-align: center; padding: 16px 0; font-family: 'IBM Plex Mono', monospace; }
  .doc-item { display: flex; align-items: center; gap: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; transition: border-color .2s; }
  .doc-item:hover { border-color: var(--accent); }
  .doc-icon { color: var(--accent); flex-shrink: 0; }
  .doc-info { flex: 1; min-width: 0; }
  .doc-name { display: block; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .doc-meta { font-size: 11px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
  .del-btn { background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px; border-radius: 6px; display: flex; transition: color .2s; flex-shrink: 0; }
  .del-btn:hover { color: #f87171; }

  /* Chat */
  .chat-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .chat-header { display: flex; align-items: center; gap: 8px; padding: 14px 24px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 700; letter-spacing: .5px; color: var(--muted); text-transform: uppercase; }

  .messages { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 20px; }
  .messages::-webkit-scrollbar { width: 6px; }
  .messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

  .msg { display: flex; gap: 12px; align-items: flex-start; }
  .msg-user { flex-direction: row-reverse; }
  .msg-avatar { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .ai-avatar   { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: white; }
  .user-avatar { background: var(--user-bg); border: 1px solid var(--border); color: var(--text); }
  .msg-bubble { max-width: min(72%, 680px); border-radius: 14px; padding: 14px 18px; position: relative; }
  .ai-bubble   { background: var(--ai-bg); border: 1px solid var(--border); }
  .user-bubble { background: var(--user-bg); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); font-size: 14px; line-height: 1.6; }

  /* Cursor blink */
  .cursor-blink { display: inline-block; width: 2px; height: 14px; background: var(--accent); margin-left: 2px; vertical-align: middle; animation: blink .8s step-end infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

  /* Typing indicator */
  .typing-bubble { display: flex; align-items: center; gap: 10px; }
  .typing-phase  { font-size: 12px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; }
  .typing-dots   { display: flex; gap: 4px; }
  .typing-dots span { width: 6px; height: 6px; background: var(--accent); border-radius: 50%; animation: bounce 1.2s infinite; }
  .typing-dots span:nth-child(2) { animation-delay: .2s; }
  .typing-dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }

  /* Markdown */
  .markdown { font-size: 14px; line-height: 1.75; }
  .md-p  { margin-bottom: 10px; }
  .md-h1 { font-size: 20px; font-weight: 800; margin: 16px 0 8px; color: var(--accent); }
  .md-h2 { font-size: 17px; font-weight: 700; margin: 14px 0 6px; }
  .md-h3 { font-size: 15px; font-weight: 600; margin: 12px 0 4px; }
  .md-ul { padding-left: 20px; margin-bottom: 10px; }
  .md-li { margin-bottom: 4px; list-style: disc; }
  .md-oli{ margin-bottom: 4px; list-style: decimal; }
  .md-hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
  .inline-code { font-family: 'IBM Plex Mono', monospace; font-size: 12px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent2); padding: 1px 6px; border-radius: 4px; }
  .code-block { font-family: 'IBM Plex Mono', monospace; font-size: 12px; background: #0a0c14; border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin: 12px 0; overflow-x: auto; line-height: 1.6; color: #a5f3fc; }

  /* Input bar */
  .input-bar { display: flex; gap: 12px; align-items: flex-end; padding: 16px 24px; border-top: 1px solid var(--border); background: var(--surface); }
  .chat-input { flex: 1; background: var(--input-bg); border: 1px solid var(--border); border-radius: 12px; color: var(--text); font-family: 'Syne', sans-serif; font-size: 14px; line-height: 1.6; padding: 12px 16px; resize: none; transition: border-color .2s; max-height: 140px; overflow-y: auto; }
  .chat-input:focus { outline: none; border-color: var(--accent); }
  .chat-input::placeholder { color: var(--muted); }
  .send-btn { background: var(--accent); border: none; border-radius: 12px; color: white; cursor: pointer; padding: 12px 14px; display: flex; align-items: center; transition: all .2s; flex-shrink: 0; }
  .send-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 80%, white); transform: translateY(-1px); }
  .send-btn:disabled { opacity: .4; cursor: not-allowed; }
  .abort-btn { background: #ef4444; }
  .abort-btn:hover { background: #dc2626 !important; }

  /* Toast */
  .toast-container { position: fixed; bottom: 24px; right: 24px; display: flex; flex-direction: column; gap: 10px; z-index: 9999; }
  .toast { display: flex; align-items: center; gap: 10px; font-size: 13px; padding: 12px 18px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.3); animation: slideIn .3s ease; border: 1px solid var(--border); background: var(--surface); }
  .toast-success { border-left: 3px solid #22c55e; }
  .toast-success svg { color: #22c55e; }
  .toast-error { border-left: 3px solid #ef4444; }
  .toast-error svg { color: #ef4444; }
  @keyframes slideIn { from{transform:translateX(60px);opacity:0} to{transform:translateX(0);opacity:1} }

  /* Utility */
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to{transform:rotate(360deg)} }
`;
