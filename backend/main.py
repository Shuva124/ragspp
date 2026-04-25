import os
import asyncio
import tempfile
from typing import AsyncGenerator

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from langchain_community.document_loaders import PyPDFLoader, TextLoader, Docx2txtLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import FAISS

from openai import OpenAI

# ── Config ─────────────────────────────────────────
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

if not OPENROUTER_API_KEY:
    raise ValueError("OPENROUTER_API_KEY not set")

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200
TOP_K = 4

# ── OpenRouter client ──────────────────────────────
client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=OPENROUTER_API_KEY
)

# ── ✅ FIXED: Use API embeddings (NO OOM) ──────────
embeddings = OpenAIEmbeddings(
    base_url="https://openrouter.ai/api/v1",
    api_key=OPENROUTER_API_KEY,
    model="text-embedding-3-small"
)

vector_store = None
uploaded_docs: list[dict] = []

app = FastAPI(title="RAG API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Loader helper ──────────────────────────────────
def get_loader(path: str, filename: str):
    ext = filename.rsplit(".", 1)[-1].lower()
    if ext == "pdf":
        return PyPDFLoader(path)
    elif ext in ("doc", "docx"):
        return Docx2txtLoader(path)
    else:
        return TextLoader(path, encoding="utf-8")

# ── Streaming RAG ──────────────────────────────────
async def stream_rag_response(query: str) -> AsyncGenerator[str, None]:
    global vector_store

    if vector_store is None:
        yield "No documents uploaded yet."
        return

    docs = vector_store.similarity_search(query, k=TOP_K)

    if not docs:
        yield "No relevant context found."
        return

    context = "\n\n---\n\n".join(
        f"[Source: {d.metadata.get('source','unknown')}]\n{d.page_content}"
        for d in docs
    )

    system_prompt = f"""
You are an expert assistant. Answer ONLY from context.

CONTEXT:
{context}
"""

    try:
        response = client.chat.completions.create(
            model="meta-llama/llama-3-8b-instruct",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": query},
            ],
            stream=True,
        )

        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
                await asyncio.sleep(0)

    except Exception as e:
        yield f"\n[ERROR]: {str(e)}"

# ── Request model ──────────────────────────────────
class ChatRequest(BaseModel):
    query: str

# ── Endpoints ──────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "docs_loaded": len(uploaded_docs)}

@app.get("/documents")
async def list_documents():
    return {"documents": uploaded_docs}

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    global vector_store

    ext = file.filename.rsplit(".", 1)[-1].lower()
    content = await file.read()

    with tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}") as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        loader = get_loader(tmp_path, file.filename)
        raw_docs = loader.load()

        splitter = RecursiveCharacterTextSplitter(
            chunk_size=CHUNK_SIZE,
            chunk_overlap=CHUNK_OVERLAP,
        )
        chunks = splitter.split_documents(raw_docs)

        for chunk in chunks:
            chunk.metadata["source"] = file.filename

        if vector_store is None:
            vector_store = FAISS.from_documents(chunks, embeddings)
        else:
            vector_store.add_documents(chunks)

        uploaded_docs.append({
            "id": file.filename,
            "name": file.filename,
            "chunks": len(chunks)
        })

    except Exception as e:
        print("UPLOAD ERROR:", str(e))
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        os.unlink(tmp_path)

    return {"message": "Uploaded", "chunks": len(chunks)}

@app.post("/chat")
async def chat(req: ChatRequest):
    return StreamingResponse(
        stream_rag_response(req.query),
        media_type="text/event-stream",
    )