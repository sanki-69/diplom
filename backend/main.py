import os
import json
import re

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from langdetect import detect
from dotenv import load_dotenv
from openai import OpenAI

# -----------------------
# Setup
# -----------------------
load_dotenv()

api_key = os.getenv("OPENAI_API_KEY", "").strip()
client = OpenAI(api_key=api_key) if api_key else None

app = FastAPI()

# Dev CORS (allow extension to call backend)
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
    """
    LLM sometimes returns JSON inside ```json fences or adds extra text.
    This tries:
    1) direct json.loads
    2) extract first {...} block and parse
    """
    if not text:
        return None

    # Remove code fences if present
    text = re.sub(r"```json", "", text, flags=re.IGNORECASE)
    text = re.sub(r"```", "", text)
    text = text.strip()

    # Try direct parse
    try:
        return json.loads(text)
    except Exception:
        pass

    # Try extracting first JSON object
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            pass

    return None

def call_llm_translate_explain(req: AnalyzeRequest, detected_lang: str) -> dict:
    if client is None:
        raise Exception("OPENAI_API_KEY is missing. backend/.env дотор OPENAI_API_KEY=sk-... гэж зөв тавь.")

    system = (
        "Та онлайн худалдааны AI туслах. "
        "Таны зорилго: хэлний саадыг арилгах. "
        "Оролтын хэл (англи/хятад гэх мэт) ямар ч байсан Монгол хэлээр ойлгомжтой, хэрэглэгчдэд ээлтэй хариул."
    )

    user = f"""
Бүтээгдэхүүний мэдээлэл:
- Title: {req.title}
- Price: {req.price}
- Description/Text: {req.description}
- URL: {req.url}
- Detected language: {detected_lang}

Даалгавар:
1) Title, Description-ийг Монгол хэл рүү ОРЧУУЛ.
2) Хэрэглэгчид ойлгомжтой байдлаар товч тайлбар (юунд хэрэгтэй, юуг анхаарах).
3) Хэрвээ хэрэглэгч асуулттай бол тусад нь Монгол хэлээр хариул.

Зөвхөн JSON буцаа. Өөр тайлбар бүү нэм.
Формат:
{{
  "mn_title": "...",
  "mn_description": "...",
  "ai_explanation": "...",
  "question_answer": "..."  // асуулт байхгүй бол хоосон string
}}
"""

    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
    )

    raw = (resp.choices[0].message.content or "").strip()

    # ✅ DEBUG: print raw LLM response
    print("\n=== LLM RAW RESPONSE START ===")
    print(raw)
    print("=== LLM RAW RESPONSE END ===\n")

    parsed = safe_json_extract(raw)
    if not parsed:
        snippet = raw[:400].replace("\n", " ")
        raise Exception(f"LLM JSON parse failed. Snippet: {snippet}")

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
        out = call_llm_translate_explain(req, lang)

        explanation = (
            f"📌 Монгол нэр: {out.get('mn_title','')}\n"
            f"💰 Үнэ: {req.price}\n"
            f"🌐 Илэрсэн хэл: {lang}\n"
            f"🔗 Линк: {req.url}\n\n"
            f"📝 Монгол орчуулга:\n{out.get('mn_description','')}\n\n"
            f"🤖 AI тайлбар:\n{out.get('ai_explanation','')}\n"
        )

        if (req.question or "").strip():
            explanation += f"\n❓Асуулт: {req.question}\n👉 Хариу: {out.get('question_answer','')}\n"

        return {
            "detected_language": lang,
            "mn": {
                "title": out.get("mn_title", ""),
                "description": out.get("mn_description", "")
            },
            "explanation": explanation
        }

    except Exception as e:
        # ✅ DEBUG: show exact error in popup
        return {
            "detected_language": lang,
            "error": str(e),
            "explanation": f"ALDAA: {str(e)}"
        }