'use strict';

/**
 * background.js (Service Worker)
 *
 *  1. FETCH_HTML       : 지정 URL의 HTML/JSON을 가져와 text로 반환
 *  2. FETCH_ORDER_PAGE : 탭을 열어 __NEXT_DATA__ 읽기 (쿠팡 페이지네이션)
 *  3. CAPTURE_RECEIPT  : 영수증 탭 캡처 (네이버: 2단계 — hist → 카드영수증)
 *  4. DOWNLOAD_FILE    : dataUrl → 파일 저장
 */

// ── SW keep-alive ──────────────────────────────────────────────────────────
let _activeOps = 0;
let _kaTimer   = null;

// ── 다운로드 파일명 오버라이드 ──────────────────────────────────────────────
let _pendingDownloadFilename = null;
chrome.downloads.onDeterminingFilename.addListener((_item, suggest) => {
  if (_pendingDownloadFilename) {
    const f = _pendingDownloadFilename;
    _pendingDownloadFilename = null;
    suggest({ filename: f, conflictAction: 'uniquify' });
  }
});

function _opStart() {
  _activeOps++;
  if (!_kaTimer) {
    _kaTimer = setInterval(() => {
      if (_activeOps > 0) chrome.storage.local.get('_ka').catch(() => {});
    }, 20000);
  }
}
function _opEnd() {
  _activeOps = Math.max(0, _activeOps - 1);
  if (_activeOps === 0 && _kaTimer) { clearInterval(_kaTimer); _kaTimer = null; }
}

// ── 탭 로드 완료 대기 ────────────────────────────────────────────────────
function _waitTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('탭 로딩 타임아웃')), timeoutMs);
    chrome.tabs.onUpdated.addListener(function onUpd(tid, info) {
      if (tid !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve();
    });
  });
}

// ── executeScript — 탭 준비될 때까지 재시도 (최대 maxMs) ──────────────────
async function _execWhenReady(tabId, opts, maxMs = 10000, intervalMs = 80) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await chrome.scripting.executeScript({ target: { tabId }, ...opts });
      return res;
    } catch (_) {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── HTML/JSON fetch 대리 ─────────────────────────────────────────────────
  if (msg.action === 'FETCH_HTML') {
    const { url, referer } = msg;
    const headers = {
      'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    };
    if (referer) headers['Referer'] = referer;
    fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store', headers })
      .then(async res => {
        if (!res.ok) sendResponse({ ok: false, status: res.status });
        else sendResponse({ ok: true, text: await res.text() });
      })
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // ── 쿠팡 주문 페이지 탭 로딩 ───────────────────────────────────────────
  if (msg.action === 'FETCH_ORDER_PAGE') {
    const { url } = msg;
    _opStart();
    (async () => {
      let win = null;
      try {
        win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
        const tabId    = win.tabs[0].id;
        const windowId = win.id;

        await _waitTabLoad(tabId, 25000);

        for (let waited = 0; waited < 2000; waited += 100) {
          const { wmStopRequested } = await chrome.storage.local.get('wmStopRequested');
          if (wmStopRequested) {
            await chrome.windows.remove(windowId);
            win = null;
            sendResponse({ ok: false, stopped: true });
            return;
          }
          await new Promise(r => setTimeout(r, 100));
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: () => { try { const d = window.__NEXT_DATA__; return d ? JSON.parse(JSON.stringify(d)) : null; } catch { return null; } },
        });

        await chrome.windows.remove(windowId);
        win = null;
        sendResponse({ ok: true, nextData: results?.[0]?.result ?? null });
      } catch (e) {
        if (win) await chrome.windows.remove(win.id).catch(() => {});
        sendResponse({ ok: false, error: String(e) });
      } finally { _opEnd(); }
    })();
    return true;
  }

  // ── 영수증 탭 캡처 ──────────────────────────────────────────────────────
  if (msg.action === 'CAPTURE_RECEIPT') {
    const { url, cards = [] } = msg;  // cards: [{ company, lastFour }, ...]
    const originWindowId = _sender?.tab?.windowId ?? null;

    _opStart();
    (async () => {
      let win = null;
      try {
        // ── 쿠팡: 주문상세 fetch → 카드사 사전 확인 (창 열기 없이) ──────────────
        if (url.includes('mc.coupang.com') && cards.length > 0) {
          const orderId = url.match(/orderId=([^&]+)/)?.[1];
          if (orderId) {
            try {
              const resp = await fetch(`https://mc.coupang.com/ssr/desktop/order/${orderId}`, {
                credentials: 'include',
                cache: 'no-store',
                headers: { 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'ko-KR,ko;q=0.9' },
              });
              if (resp.ok) {
                const html = await resp.text();
                // "NH농협비씨카드 / 일시불" 또는 "현대카드 / 3개월" 패턴 추출
                const m = html.match(/([^<>\s\/]{2,20}카드)\s*\/\s*(일시불|[0-9]+개월)/);
                const foundCard = m ? m[1].trim() : null;
                console.log(`[BG][쿠팡] 주문상세 카드사: "${foundCard}"`);
                if (foundCard) {
                  const ALIASES = {
                    'BC카드':     ['BC', '비씨', 'BCCARD', 'BC카드', 'NH농협비씨카드', '기업비씨카드'],
                    'NH농협카드': ['농협카드', 'NH농협', 'NH농협카드'],
                    '기업BC카드': ['기업BC', '기업비씨', '기업BC카드'],
                  };
                  const isMatched = cards.some(card => {
                    const kws = [card.company, ...(ALIASES[card.company] || [])];
                    return kws.some(kw => kw && foundCard.includes(kw));
                  });
                  if (!isMatched) {
                    console.log(`[BG][쿠팡] 카드사 불일치(${foundCard}) → 스킵`);
                    sendResponse({ ok: false, error: '카드사 불일치 — 저장 스킵', matched: false });
                    _opEnd();
                    return;
                  }
                  console.log(`[BG][쿠팡] 카드사 매칭(${foundCard}) → 거래명세서 열기`);
                }
              }
            } catch (e) {
              console.warn('[BG][쿠팡] 주문상세 fetch 실패, 거래명세서로 진행:', e);
            }
          }
        }

        // ── 거래명세서 / 카드영수증 창 열기 ─────────────────────────────────
        win = await chrome.windows.create({ url, focused: true, width: 1280, height: 900 });
        let tabId          = win.tabs[0].id;
        let activeWindowId = win.id;

        // ── 네이버: 카드영수증 버튼 클릭 → URL 인터셉트 ─────────────────────
        if (!url.includes('mc.coupang.com')) {

          // 1) "카드영수증" 버튼 폴링
          const btnDeadline = Date.now() + 8000;
          while (Date.now() < btnDeadline) {
            const { wmStopRequested } = await chrome.storage.local.get('wmStopRequested');
            if (wmStopRequested) {
              await chrome.windows.remove(activeWindowId).catch(() => {});
              win = null;
              if (originWindowId) chrome.windows.update(originWindowId, { focused: true }).catch(() => {});
              sendResponse({ ok: false, stopped: true }); return;
            }
            try {
              const [chk] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => Array.from(document.querySelectorAll('a')).some(a =>
                  a.textContent.trim() === '카드영수증' || (a.className || '').includes('rec.card')
                ),
              });
              if (chk?.result) break;
            } catch (_) {}
            await new Promise(r => setTimeout(r, 150));
          }

          // 2) window.open 패칭 + 버튼 클릭 → URL 인터셉트
          const [interceptRes] = await chrome.scripting.executeScript({
            target: { tabId },
            world:  'MAIN',
            func: () => new Promise(resolve => {
              const origOpen = window.open.bind(window);
              let settled = false;
              window.open = (...args) => {
                const u = String(args[0] || '');
                if (!settled && u.includes('pay.naver.com/receipts')) {
                  settled = true; window.open = origOpen; resolve(u); return null;
                }
                return origOpen(...args);
              };
              setTimeout(() => { if (!settled) { window.open = origOpen; resolve(null); } }, 3000);
              const btn = Array.from(document.querySelectorAll('a')).find(a =>
                a.textContent.trim() === '카드영수증' || (a.className || '').includes('rec.card')
              );
              if (btn) btn.click(); else resolve(null);
            }),
          }).catch(() => [{ result: null }]);

          const cardReceiptUrl = interceptRes?.result ?? null;

          if (cardReceiptUrl) {
            await chrome.windows.remove(activeWindowId).catch(() => {});
            win = null;
            win = await chrome.windows.create({ url: cardReceiptUrl, focused: true, width: 1280, height: 900 });
            tabId          = win.tabs[0].id;
            activeWindowId = win.id;
          } else {
            console.warn('[BG] 카드영수증 URL 가로채기 실패 — hist 페이지 fallback');
          }
        }

        // 탭 로드 완료 대기 (쿠팡 + 네이버 공통)
        await _waitTabLoad(tabId, 20000);

        // ── h2c 주입 + 데이터 폴링 (병렬) ────────────────────────────────
        const h2cPromise = _execWhenReady(tabId, { files: ['libs/html2canvas.min.js'] }, 6000, 80);

        const dataDeadline = Date.now() + 6000;
        while (Date.now() < dataDeadline) {
          const { wmStopRequested } = await chrome.storage.local.get('wmStopRequested');
          if (wmStopRequested) {
            await chrome.windows.remove(activeWindowId).catch(() => {});
            win = null;
            if (originWindowId) chrome.windows.update(originWindowId, { focused: true }).catch(() => {});
            sendResponse({ ok: false, stopped: true }); return;
          }
          try {
            const [chk] = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const raw = (document.body?.innerText || '').replace(/\s+/g, ' ');
                return (
                  /(거래일시|결제일시|주문일시|승인일시|카드영수증).{0,40}\d{4}[.\/-]\d{1,2}/.test(raw) ||
                  /[1-9][\d,]*\s*원/.test(raw) ||
                  /[\d*]{4}[-\s][\d*]{4}[-\s][\d*]{4}[-\s]\d{4}/.test(raw)
                );
              },
            });
            if (chk?.result) break;
          } catch (_) {}
          await new Promise(r => setTimeout(r, 50));
        }

        await h2cPromise;

        // ── 캡처 ─────────────────────────────────────────────────────────
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (cardsToMatch, companies) => new Promise(async (resolve) => {
            // 원본 url은 hist URL이므로 실제 탭 URL로 판별
            const isNaverCardPage = window.location.href.includes('pay.naver.com/receipts/preview/card');
            const text = document.body?.innerText || document.body?.textContent || '';

            // ── 카드사 동의어 ──────────────────────────────────────────────────────
            const ALIASES = {
              'BC카드':     ['BC', '비씨', 'BCCARD', 'BC카드', 'NH농협비씨카드', '기업비씨카드'],
              'NH농협카드': ['농협카드', 'NH농협', 'NH농협카드'],
              '기업BC카드': ['기업BC', '기업비씨', '기업BC카드'],
            };

            // ── 1단계: 카드사명 추출 (innerText + __NEXT_DATA__ 병행) ───────────────
            // __NEXT_DATA__ 스크립트 태그에서 '카드' 포함 문자열 수집
            const cardCandidates = [];
            try {
              const el = document.getElementById('__NEXT_DATA__');
              if (el) {
                const deepSearch = (obj, depth = 0) => {
                  if (!obj || typeof obj !== 'object' || depth > 8) return;
                  for (const v of Object.values(obj)) {
                    if (typeof v === 'string' && /카드/.test(v) && v.length <= 30) cardCandidates.push(v);
                    else deepSearch(v, depth + 1);
                  }
                };
                deepSearch(JSON.parse(el.textContent)?.props?.pageProps);
              }
            } catch {}
            const allText = text + ' ' + cardCandidates.join(' ');

            let extractedCardCompany = null;
            for (const company of (companies || [])) {
              const keywords = [company, ...(ALIASES[company] || [])];
              if (keywords.some(kw => kw && allText.includes(kw))) {
                extractedCardCompany = company;
                break;
              }
            }

            // ── 2단계: 카드번호 뒷 4자리 추출 ──────────────────────────────────────
            let extractedLastFour = null;
            const cardRegex = /[\d*]{4}[-\s][\d*]{4}[-\s][\d*]{4}[-\s](\d{4})/;
            const match = text.match(cardRegex);
            if (match) {
              extractedLastFour = match[1];
            }

            // ── 3단계: 등록 카드와 일치 확인 ─────────────────────────────────────
            let matched = false;
            if (isNaverCardPage) {
              // 네이버 카드영수증: 카드사 + 뒷 4자리 모두 필수
              if (extractedCardCompany && extractedLastFour) {
                matched = (cardsToMatch || []).some(card =>
                  card.company === extractedCardCompany && card.lastFour === extractedLastFour
                );
              }
            } else {
              // 쿠팡: 주문상세 fetch에서 이미 카드사 검증 완료 → 항상 통과
              matched = true;
            }

            // ── 4단계: 캡처 ────────────────────────────────────────────────────────
            const SELS = [
              'main', 'article', '#content', '#main', '.content',
              '[class*="receipt"]', '[class*="Receipt"]',
              '[class*="order"]', '[class*="Order"]',
            ];
            let el = null;
            for (const sel of SELS) { const f = document.querySelector(sel); if (f) { el = f; break; } }
            if (!el) el = document.body;

            try {
              // eslint-disable-next-line no-undef
              const canvas = await html2canvas(el, {
                useCORS: true, allowTaint: true, scale: 2,
                backgroundColor: '#ffffff', logging: false,
              });
              resolve({
                ok: true,
                dataUrl: canvas.toDataURL('image/png'),
                matched,
                extractedCardCompany,
                extractedLastFour,
              });
            } catch (e) {
              resolve({ ok: false, error: String(e) });
            }
          }),
          args: [cards, cards.map(c => c.company)],
        });

        await chrome.windows.remove(activeWindowId).catch(() => {});
        win = null;
        if (originWindowId) chrome.windows.update(originWindowId, { focused: true }).catch(() => {});
        sendResponse(results?.[0]?.result || { ok: false, error: '캡처 결과 없음' });

      } catch (e) {
        if (win) await chrome.windows.remove(win.id).catch(() => {});
        if (originWindowId) chrome.windows.update(originWindowId, { focused: true }).catch(() => {});
        sendResponse({ ok: false, error: String(e) });
      } finally { _opEnd(); }
    })();
    return true;
  }

  // ── 파일 다운로드 ───────────────────────────────────────────────────────
  if (msg.action === 'DOWNLOAD_FILE') {
    const { dataUrl, filename, conflictAction = 'uniquify' } = msg;
    _pendingDownloadFilename = filename;
    chrome.downloads.download({ url: dataUrl, conflictAction, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        _pendingDownloadFilename = null;
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }

});
