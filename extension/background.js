// Transcript Downloader - Background Service Worker
// Handles file saves so downloads survive popup close

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SAVE_FILE') {
    const { filename, text } = msg;
    const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
      sendResponse({ ok: true, downloadId });
    });
    return true; // keep message channel open for async response
  }
});
