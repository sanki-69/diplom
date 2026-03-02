console.log("✅ content.js injected");

function clean(t){ return (t||"").replace(/\s+/g," ").trim(); }

const PRICE_RE = /(?:₮|¥|\$|€|£)\s?\d|(\d[\d.,\s]{1,}\s?(₮|¥|\$|€|£))/;

function extractProducts(){
  const nodes = Array.from(document.querySelectorAll("span,div,p,strong"))
    .filter(n=>PRICE_RE.test(clean(n.innerText)));

  const results = [];
  const seen = new Set();

  for(const el of nodes){
    const card = el.closest("a,article,li,div");
    if(!card) continue;

    const text = clean(card.innerText);
    const price = (text.match(PRICE_RE)||[""])[0];
    const img = card.querySelector("img");
    const link = card.querySelector("a[href]");

    const title = clean(img?.alt) || clean(text.replace(price,"")).slice(0,80);
    const url = link ? new URL(link.href,location.href).toString() : "";

    if(!title||!price) continue;
    const key = title+price;
    if(seen.has(key)) continue;
    seen.add(key);

    results.push({
      title,
      price,
      url,
      description: text.slice(0,300),
      rawText: text
    });

    if(results.length>=20) break;
  }
  return results;
}

// ---------- Whole page toggle ----------
let backup = null;

function collectTextNodes(){
  const walker = document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const nodes=[];
  while(walker.nextNode()){
    const t=clean(walker.currentNode.nodeValue);
    if(t.length>1 && t.length<500) nodes.push(walker.currentNode);
  }
  return nodes;
}

async function translatePage(){
  if(backup) return;
  const nodes = collectTextNodes();
  backup = new Map();
  const texts=[];

  for(const n of nodes){
    backup.set(n,n.nodeValue);
    texts.push(n.nodeValue);
  }

  const res = await fetch("http://127.0.0.1:8000/translate_page",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({texts})
  });
  const data=await res.json();
  if(!data.translated) return;

  nodes.forEach((n,i)=>{
    if(data.translated[i]) n.nodeValue=data.translated[i];
  });
}

function restorePage(){
  if(!backup) return;
  for(const [node,txt] of backup.entries()){
    node.nodeValue=txt;
  }
  backup=null;
}

chrome.runtime.onMessage.addListener((req,sender,sendResponse)=>{
  if(req.action==="MVP_EXTRACT"){
    sendResponse({ok:true,products:extractProducts()});
  }
  if(req.action==="PAGE_TRANSLATE_TOGGLE"){
    if(req.enabled) translatePage();
    else restorePage();
    sendResponse({ok:true});
  }
});