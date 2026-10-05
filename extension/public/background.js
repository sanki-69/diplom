// Re-inject the widget when navigating within the same tab (SPA navigation)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    }).catch(() => {});
  }
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {

  // Open a URL in a new tab (plain)
  if (req.action === "OPEN_TAB" && req.url) {
    chrome.tabs.create({ url: req.url, active: true });
    sendResponse({ ok: true });
    return;
  }

  // OPEN_TAB_WITH_PRODUCT: same as OPEN_TAB — product context handled inside the widget naturally
  if (req.action === "OPEN_TAB_WITH_PRODUCT" && req.url) {
    chrome.tabs.create({ url: req.url, active: true });
    sendResponse({ ok: true });
    return;
  }
});
