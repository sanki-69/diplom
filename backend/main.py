import json
import re
import requests

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from langdetect import detect

# -----------------------
# Setup
# -----------------------
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev only
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------
# Models
# -----------------------
class AnalyzeRequest(BaseModel):
    title: str = ""
    price: str = ""
    url: str = ""
    description: str = ""
    question: str = ""

# -----------------------
# Helpers
# -----------------------
def safe_detect(text: str) -> str:
    try:
        t = (text or "").strip()
        if len(t) < 5:
            return "unknown"
        return detect(t)
    except Exception:
        return "unknown"

def safe_json_extract(text: str):
    if not text:
        return None

    # Remove fences if present
    text = re.sub(r"```json", "", text, flags=re.IGNORECASE)
    text = re.sub(r"```", "", text)
    text = text.strip()

    # Try direct parse
    try:
        return json.loads(text)
    except Exception:
        pass

    # Try extracting first {...} block
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            pass

    return None

def ollama_generate(prompt: str, model: str = "llama3.1:8b") -> str:
    """
    Calls local Ollama server using /api/generate (most compatible).
    Ollama should be running at http://127.0.0.1:11434
    """
    url = "http://127.0.0.1:11434/api/generate"

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False
    }

    r = requests.post(url, json=payload, timeout=120)
    r.raise_for_status()
    data = r.json()

    # /api/generate returns {"response": "...", ...}
    return (data.get("response") or "").strip()

def translate_and_explain(req: AnalyzeRequest, detected_lang: str) -> dict:
    prompt = f"""
Та онлайн худалдааны AI туслах.
Зорилго: Хэлний саадыг арилгах.

Бүтээгдэхүүний мэдээлэл:
- Title: {req.title}
- Price: {req.price}
- Description/Text: {req.description}
- URL: {req.url}
- Detected language: {detected_lang}

Хэрэглэгчийн асуулт:
{req.question if req.question else "Асуулт байхгүй"}

Даалгавар:
1) Title, Description/Text-ийг Монгол хэл рүү ОРЧУУЛ.
2) Хэрэглэгчид ойлгомжтой байдлаар товч тайлбар (юунд хэрэгтэй, юуг анхаарах).
3) Хэрвээ хэрэглэгч асуулттай бол тусад нь Монгол хэлээр хариул.

ЗӨВХӨН JSON буцаа.
- Код блок (``` ) ашиглахгүй.
- JSON-оос өөр текст бүү нэм.

Формат яг ийм:
{{
  "mn_title": "...",
  "mn_description": "...",
  "ai_explanation": "...",
  "question_answer": "..." 
}}
"""

    raw = ollama_generate(prompt)

    # DEBUG
    print("\n=== OLLAMA RAW START ===")
    print(raw)
    print("=== OLLAMA RAW END ===\n")

    parsed = safe_json_extract(raw)
    if not parsed:
        snippet = raw[:400].replace("\n", " ")
        raise Exception(f"Ollama JSON parse failed. Snippet: {snippet}")

    # Ensure keys exist
    parsed.setdefault("mn_title", "")
    parsed.setdefault("mn_description", "")
    parsed.setdefault("ai_explanation", "")
    parsed.setdefault("question_answer", "")

    return parsed

# -----------------------
# Routes
# -----------------------
@app.get("/health")
def health():
    return {"ok": True}

@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    combined = f"{req.title}\n{req.description}".strip()
    lang = safe_detect(combined)

    try:
        out = translate_and_explain(req, lang)

        explanation = (
            f"📌 Монгол нэр: {out.get('mn_title','')}\n"
            f"💰 Үнэ: {req.price}\n"
            f"🌐 Илэрсэн хэл: {lang}\n"
            f"🔗 Линк: {req.url}\n\n"
            f"📝 Монгол орчуулга:\n{out.get('mn_description','')}\n\n"
            f"🤖 AI тайлбар:\n{out.get('ai_explanation','')}\n"
        )

        if (req.question or "").strip():
            explanation += (
                f"\n❓Асуулт: {req.question}\n"
                f"👉 Хариу: {out.get('question_answer','')}\n"
            )

        return {
            "detected_language": lang,
            "mn": {
                "title": out.get("mn_title", ""),
                "description": out.get("mn_description", "")
            },
            "explanation": explanation
        }

    except Exception as e:
        return {
            "detected_language": lang,
            "error": str(e),
            "explanation": f"ALDAA: {str(e)}"
        }