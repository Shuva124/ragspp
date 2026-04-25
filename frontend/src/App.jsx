import { useState, useRef, useEffect } from "react";
import { Upload, Send, Bot, User, Loader2 } from "lucide-react";

// ── Config ─────────────────────────────────────────
const API = "https://ragspp.onrender.com";

export default function App() {
  const [messages, setMessages] = useState([
    { role: "ai", content: "Upload documents and ask questions!" }
  ]);
  const [input, setInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const fileInputRef = useRef();
  const chatEndRef = useRef();
  const abortRef = useRef(null);

  // ✅ USER ID (IMPORTANT)
  let user_id = localStorage.getItem("user_id");
  if (!user_id) {
    user_id = crypto.randomUUID();
    localStorage.setItem("user_id", user_id);
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Upload ───────────────────────────────────────
  async function handleUpload(files) {
    if (!files?.length) return;
    setUploading(true);

    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("user_id", user_id); // ✅ REQUIRED

      try {
        const res = await fetch(`${API}/upload`, {
          method: "POST",
          body: fd,
        });

        const data = await res.json();

        if (res.ok) {
          alert(`Uploaded ${file.name} (${data.chunks} chunks)`);
        } else {
          alert(data.detail || "Upload failed");
        }
      } catch {
        alert("Upload failed");
      }
    }

    setUploading(false);
  }

  // ── Chat ─────────────────────────────────────────
  async function sendMessage() {
    const query = input.trim();
    if (!query || streaming) return;

    setInput("");
    setMessages(p => [...p, { role: "user", content: query }]);
    setStreaming(true);

    const aiId = Date.now();
    setMessages(p => [...p, { role: "ai", content: "", id: aiId }]);

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          user_id // ✅ REQUIRED
        }),
        signal: controller.signal
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        full += chunk;

        setMessages(p =>
          p.map(m => m.id === aiId ? { ...m, content: full } : m)
        );
      }

    } catch (err) {
      setMessages(p =>
        p.map(m =>
          m.id === aiId
            ? { ...m, content: "Error occurred" }
            : m
        )
      );
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h2>RAG Chat</h2>

      {/* Upload */}
      <div>
        <button onClick={() => fileInputRef.current.click()}>
          <Upload /> Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={e => handleUpload(e.target.files)}
        />
        {uploading && <Loader2 className="spin" />}
      </div>

      {/* Chat */}
      <div style={{ marginTop: 20 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <b>{m.role === "ai" ? "AI" : "You"}:</b> {m.content}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div style={{ marginTop: 10 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask something..."
          style={{ width: "70%", padding: 8 }}
        />
        <button onClick={sendMessage} disabled={streaming}>
          <Send />
        </button>
      </div>
    </div>
  );
}