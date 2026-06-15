'use strict';

/**
 * content.js v2.0 — 백그라운드 Fetch·가상 DOM 캡처 방식
 *
 * 주입 순서: html2canvas → parsers/coupang.js → parsers/naverpay.js
 *           → parsers/index.js → content.js (이 파일)
 *
 * ── 처리 흐름 ─────────────────────────────────────────────────────────
 *  1. 파서로 주문 목록 아이템 수집
 *  2. (선택) 날짜 범위 필터링 — 사용자 화면 이동 없음
 *  3. 파서에서 영수증 URL 추출
 *  4. fetch()로 영수증 HTML 취득 (백그라운드, 사용자 화면 변화 없음)
 *  5. DOMParser로 가상 Document 생성 → 카드 번호 매칭
 *  6. 일치하면 해당 요소를 화면 밖 hidden div에 주입 → html2canvas 캡처
 *  7. hidden div 즉시 제거 → PNG 다운로드
 * ─────────────────────────────────────────────────────────────────────
 */

// ── 공통 유틸 ─────────────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * dateRange 를 폴더명용 기간 문자열로 변환한다.
 * { start:'2026-06-01', end:'2026-06-13' } → '260601-260613'
 */
function _formatPeriod(dateRange) {
  if (!dateRange || !dateRange.start) return '전체';
  const fmt = s => s.replace(/-/g, '').slice(2);
  const s = fmt(dateRange.start);
  const e = fmt(dateRange.end || dateRange.start);
  return s === e ? s : `${s}-${e}`;
}

/**
 * OS 금지 문자(\/:*?"<>|)를 언더바로 치환하고 중복·앞뒤 언더바를 정리한다.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim() || 'unknown';
}

/**
 * Date 또는 날짜 문자열을 YYMMDD 형식으로 변환한다.
 * @param {Date|string|null} input
 * @returns {string}  예: "260611"
 */
function formatDateYYMMDD(input) {
  let d = input instanceof Date ? input : _parseKoreanDate(String(input || ''));
  if (!d || isNaN(d.getTime())) d = new Date();
  return [
    String(d.getFullYear()).slice(2),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('');
}

/**
 * 한국 쇼핑몰에서 쓰이는 날짜 문자열 파싱.
 * @param {string} str
 * @returns {Date|null}
 */
function _parseKoreanDate(str) {
  str = str.trim();
  let m = str.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = str.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = str.match(/^(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return new Date(2000 + +m[1], +m[2] - 1, +m[3]);
  return null;
}

/**
 * Date가 날짜 범위 [start, end] 안에 있는지 확인한다.
 * @param {Date}   date
 * @param {{start:string, end:string}} range  - "YYYY-MM-DD"
 * @returns {boolean}
 */
function isInDateRange(date, range) {
  if (!date || !range) return true;
  const ymd = d => d.toISOString().slice(0, 10);
  const t   = ymd(date);
  return t >= range.start && t <= range.end;
}

/**
 * 카드사명(orderCardCompany)이 등록 카드 목록과 일치하는 카드를 반환한다.
 * background.js ALIASES 와 동기화.
 * @param {string} orderCardCompany
 * @param {Array}  cards  - selectedCards
 * @returns {object|null}
 */
function _findMatchingCard(orderCardCompany, cards) {
  const ALIASES = {
    'BC카드':     ['BC', '비씨', 'BCCARD', 'BC카드', 'NH농협비씨카드', '기업비씨카드'],
    'NH농협카드': ['농협카드', 'NH농협', 'NH농협카드'],
    '기업BC카드': ['기업BC', '기업비씨', '기업BC카드'],
  };
  return cards.find(card => {
    const kws = [card.company, ...(ALIASES[card.company] || [])];
    return kws.some(kw => kw && orderCardCompany.includes(kw));
  }) || null;
}

// ── 토스트 알림 ──────────────────────────────────────────────────────────────

const Toast = (() => {
  const CID = '__wm_toast_c__';
  const SID = '__wm_toast_s__';

  function _ensureStyles() {
    if (document.getElementById(SID)) return;
    const s = document.createElement('style');
    s.id = SID;
    s.textContent = `
      #${CID}{position:fixed;top:16px;right:16px;z-index:2147483647;
        display:flex;flex-direction:column;gap:8px;
        pointer-events:none;max-width:320px;font-family:"Malgun Gothic",sans-serif}
      .wm-t{display:flex;align-items:flex-start;gap:9px;padding:10px 13px;
        border-radius:7px;font:500 13px/1.4 inherit;
        box-shadow:0 4px 14px rgba(0,0,0,.22);pointer-events:auto;animation:wmIn .22s ease}
      .wm-t.out{animation:wmOut .22s ease forwards}
      .wm-td{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:4px}
      .wm-tb{flex:1;color:#fff}
      .wm-t.info{background:#1a3a6b} .wm-t.success{background:#137333}
      .wm-t.warning{background:#b06000} .wm-t.error{background:#c5221f}
      .wm-t.progress{background:#1a3a6b}
      .wm-t.info .wm-td,.wm-t.success .wm-td,.wm-t.warning .wm-td,
      .wm-t.error .wm-td{background:rgba(255,255,255,.65)}
      .wm-t.progress .wm-td{background:rgba(255,255,255,.65);animation:wmPulse 1.1s ease infinite}
      @keyframes wmIn{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
      @keyframes wmOut{from{opacity:1;transform:none}to{opacity:0;transform:translateX(18px)}}
      @keyframes wmPulse{0%,100%{opacity:1}50%{opacity:.2}}
    `;
    document.head.appendChild(s);
  }

  function _wrap() {
    let c = document.getElementById(CID);
    if (!c) { c = document.createElement('div'); c.id = CID; document.body.appendChild(c); }
    return c;
  }

  function _relay(text, type) {
    chrome.runtime.sendMessage({ action: 'STATUS_UPDATE', text, statusType: type }).catch(() => {});
  }

  function show(msg, type = 'info', ms = 4500) {
    _ensureStyles();
    const t = document.createElement('div');
    t.className = `wm-t ${type}`;
    t.innerHTML = `<div class="wm-td"></div><div class="wm-tb">${msg}</div>`;
    _wrap().appendChild(t);
    _relay(msg, type);
    if (ms > 0) setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 240); }, ms);
    return t;
  }

  function update(el, msg, type) {
    if (!el || !document.body.contains(el)) return;
    el.className = `wm-t ${type}`;
    el.querySelector('.wm-tb').textContent = msg;
    _relay(msg, type);
  }

  function dismiss(el, delay = 3000) {
    if (!el) return;
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 240); }, delay);
  }

  return { show, update, dismiss };
})();

// ── 메인 추출 루프 ────────────────────────────────────────────────────────────

let _isRunning = false;

/**
 * @param {Array}   selectedCards   - [{ id, alias, company, lastFour }]
 * @param {object|null} dateRange   - { start:'YYYY-MM-DD', end:'YYYY-MM-DD' } | null
 * @param {boolean} allCaptureMode  - true 시 카드 매칭 없이 전체 영수증 캡처
 */
async function startExtraction({ selectedCards, dateRange, allCaptureMode = false }) {

  if (_isRunning) {
    Toast.show('이미 추출 작업이 진행 중입니다.', 'warning');
    return;
  }
  _isRunning = true;

  // 이전 중지 요청 플래그 초기화
  await chrome.storage.local.remove('wmStopRequested');

  const progress = Toast.show('준비 중...', 'progress', 0);

  try {
    // ── 사전 확인 ─────────────────────────────────────────────────────────
    const parser = ParserRegistry.getParser(window.location.hostname);
    if (!parser) {
      Toast.update(progress, '지원하지 않는 페이지입니다. 쿠팡(mc) 또는 네이버쇼핑 주문내역 페이지에서 실행해주세요.', 'error');
      Toast.dismiss(progress, 0); return;
    }

    if (!parser.isOrderListPage()) {
      Toast.update(progress, `${parser.name} 주문내역 페이지로 이동 후 다시 시도해주세요.`, 'warning');
      Toast.dismiss(progress, 0); return;
    }

    if (typeof html2canvas !== 'function') {
      Toast.update(progress, 'html2canvas 라이브러리 누락: libs/html2canvas.min.js를 확인해주세요.', 'error');
      Toast.dismiss(progress, 0); return;
    }

    // ── 주문 아이템 수집 (async 파서 지원) ───────────────────────────────
    Toast.update(progress, '주문 목록 수집 중...', 'progress');
    let orderItems;
    try {
      orderItems = await parser.getOrderItems(dateRange);
    } catch (err) {
      console.error('[WM] getOrderItems:', err);
      Toast.update(progress, '쇼핑몰 페이지 구조가 변경되었습니다. 관리자에게 문의하세요.', 'error');
      Toast.dismiss(progress, 0); return;
    }

    // 수집 중 중지 요청이 있었는지 확인
    {
      const { wmStopRequested } = await chrome.storage.local.get('wmStopRequested');
      if (wmStopRequested) {
        await chrome.storage.local.remove('wmStopRequested');
        Toast.update(progress, '중단됨 (주문 목록 수집 중 중지)', 'warning');
        Toast.dismiss(progress, 4000);
        return;
      }
    }

    if (!orderItems.length) {
      Toast.update(progress, '주문 내역이 없거나 페이지 구조가 변경되었습니다. 관리자에게 문의하세요.', 'warning');
      Toast.dismiss(progress, 0); return;
    }

    // ── 날짜 필터 적용 → 처리 대상만 추출 ────────────────────────────────
    const targets = []; // { item, orderDate }
    for (const item of orderItems) {
      let orderDate = null;
      try { orderDate = parser.getOrderDate(item); } catch {}

      if (dateRange && orderDate && !isInDateRange(orderDate, dateRange)) continue;
      targets.push({ item, orderDate });
    }

    if (!targets.length) {
      const label = dateRange ? `(${dateRange.start} ~ ${dateRange.end})` : '';
      Toast.update(progress, `해당 기간에 주문 내역이 없습니다. ${label}`, 'warning');
      Toast.dismiss(progress, 0); return;
    }

    Toast.update(progress, `${parser.name} — ${targets.length}건 명세서 조회 시작...`, 'progress');

    const cardLastFours = selectedCards.map(c => c.lastFour);
    let matched = 0;
    let errors  = 0;
    let noUrl   = 0;   // 영수증 URL 추출 실패 건수
    let noMatch = 0;   // 카드 매칭 실패(폴백 사용) 건수

    // ── 대상 주문별 처리 ──────────────────────────────────────────────────
    for (let i = 0; i < targets.length; i++) {
      // 중지 플래그 사전 확인 (창 열기 전 빠른 탈출)
      const { wmStopRequested: earlyStop } = await chrome.storage.local.get('wmStopRequested');
      if (earlyStop) {
        await chrome.storage.local.remove('wmStopRequested');
        Toast.update(progress, `중단됨 — ${matched}건 저장 완료`, 'warning');
        Toast.dismiss(progress, 4000);
        return;
      }

      const { item, orderDate } = targets[i];

      try {
        // 1. 영수증 URL 추출 (async 파서 지원)
        let receiptUrl;
        try {
          receiptUrl = await parser.getReceiptUrl(item);
        } catch (err) {
          console.error('[WM] getReceiptUrl:', err);
          Toast.show('쇼핑몰 페이지 구조가 변경되었습니다. 관리자에게 문의하세요.', 'error');
          errors++; continue;
        }

        if (!receiptUrl) {
          console.warn(`[WM] ${i + 1}번 주문: 영수증 URL 없음 (orderId 추출 실패)`);
          noUrl++; continue;
        }

        // ── 카드사 사전 매칭 (네이버만, 쿠팡은 제거) ────────────────────────────
        // 네이버의 경우 footer에서 카드사를 제공하면 활용할 수 있으나, 현재 미구현
        let preMatchedCard = null;

        Toast.update(progress, `(${i + 1}/${targets.length}) 영수증 탭 로딩 중...`, 'progress');

        // 2. background.js 에서 실제 창을 열어 캡처 (CSS/JS 가 모두 로드된 상태)
        let captureResult;
        try {
          captureResult = await Promise.race([
            chrome.runtime.sendMessage({
              action: 'CAPTURE_RECEIPT',
              url: receiptUrl,
              // 사용자 등록 카드 정보를 전달 (카드사 + 뒷 4자리)
              cards: allCaptureMode ? [] : selectedCards.map(c => ({
                company: c.company,
                lastFour: c.lastFour,
              })),
            }),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error('캡처 타임아웃 (35초)')), 35000)
            ),
          ]);
        } catch (err) {
          console.error(`[WM] CAPTURE_RECEIPT 오류 (${i + 1}번):`, err);
          Toast.show(`캡처 오류 (${i + 1}번): ${err.message}`, 'warning');
          errors++; continue;
        }

        // ── 사전 필터링 실패 (쿠팡 카드사 불일치) ────────────────────────────
        if (captureResult?.error && captureResult?.error.includes('카드사 불일치')) {
          console.log(`[WM] ${i + 1}번: 쿠팡 카드사 불일치 → 스킵`);
          noMatch++;
          continue;
        }

        // 백그라운드에서 즉시 중단된 경우
        if (captureResult?.stopped) {
          await chrome.storage.local.remove('wmStopRequested');
          Toast.update(progress, `중단됨 — ${matched}건 저장 완료`, 'warning');
          Toast.dismiss(progress, 4000);
          return;
        }

        if (!captureResult?.ok || !captureResult.dataUrl) {
          console.warn(`[WM] 캡처 실패 (${i + 1}번):`, captureResult?.error);
          Toast.show(`캡처 실패 (${i + 1}번): ${captureResult?.error || '알 수 없는 오류'}`, 'warning');
          errors++; continue;
        }

        // ── 카드 매칭 검증 (네이버 카드영수증: 카드사 + 뒷 4자리 모두 일치 필수) ────
        if (!allCaptureMode && !captureResult.matched) {
          console.log(`[WM] ${i + 1}번: 카드영수증 미매칭(추출: ${captureResult.extractedCardCompany}/${captureResult.extractedLastFour}) — 스킵`);
          noMatch++;
          continue;
        }

        matched++;
        Toast.update(progress, `${matched}건 저장 중... (${i + 1}/${targets.length})`, 'progress');

        // 3. 파일명·경로
        const productName = (() => {
          try { return parser.getProductName(item); } catch { return '상품명미확인'; }
        })();

        const orderPrice = (() => {
          try { return parser.getOrderPrice?.(item) || null; } catch { return null; }
        })();

        let subFolder, filename;
        if (allCaptureMode) {
          // 전체 캡처 모드: 카드 구분 없이 {쇼핑몰}_전체캡처 폴더에 저장
          subFolder = sanitizeFilename(`${parser.name}_전체캡처`);
        } else {
          // 일반 모드: 실제 매칭된 카드 정보로 폴더 결정
          // 네이버: captureResult.extractedLastFour에서 카드 찾기
          // 쿠팡: preMatchedCard 사용
          let matchedCard = null;

          if (captureResult.extractedLastFour) {
            // 추출된 뒷 4자리로 등록 카드 찾기
            matchedCard = selectedCards.find(c => c.lastFour === captureResult.extractedLastFour);
          }

          if (!matchedCard && preMatchedCard) {
            // 쿠팡 사전 필터링 카드
            matchedCard = preMatchedCard;
          }

          if (!matchedCard) {
            // 폴백: 첫 번째 카드 (사실상 이 지점에는 올리면 안 되지만 safety 추가)
            matchedCard = selectedCards[0];
          }

          subFolder = sanitizeFilename(`${parser.name}_${matchedCard.alias}_${matchedCard.lastFour}`);
        }

        // 파일명: 날짜_금액_상품명 형식
        const priceStr = orderPrice ? `_${sanitizeFilename(orderPrice)}` : '';
        filename = `쇼핑_영수증/${subFolder}/${formatDateYYMMDD(orderDate)}${priceStr}_${sanitizeFilename(productName)}.png`;

        console.log(`[WM] 저장: ${filename}`);

        // 5. 다운로드 요청 (blob URL 변환은 background.js의 offscreen document에서 처리)
        const dlResult = await chrome.runtime.sendMessage({
          action:         'DOWNLOAD_FILE',
          dataUrl:        captureResult.dataUrl,
          filename,
          conflictAction: 'uniquify',
        });

        if (dlResult && !dlResult.success) {
          console.error('[WM] 다운로드 실패:', dlResult.error);
          Toast.show(`파일 저장 실패: ${dlResult.error}`, 'error');
          errors++; matched--;
        }

      } catch (err) {
        console.error(`[WM] ${i + 1}번 주문 예외:`, err);
        errors++;
        await _sleep(300);
      }
    }

    // ── 최종 결과 ─────────────────────────────────────────────────────────
    const periodLabel = dateRange ? ` (${dateRange.start} ~ ${dateRange.end})` : '';
    const skipDetail  = [
      noUrl  > 0 ? `URL없음 ${noUrl}건` : '',
      errors > 0 ? `오류 ${errors}건`   : '',
    ].filter(Boolean).join(', ');

    let finalMsg, finalType;
    if (matched === 0 && noUrl === targets.length) {
      finalMsg  = `영수증 URL을 가져오지 못했습니다. F12 콘솔에서 [WM] 로그를 확인하세요.${periodLabel}`;
      finalType = 'error';
    } else if (matched === 0) {
      finalMsg  = `저장된 파일이 없습니다.${skipDetail ? ` (${skipDetail})` : ''}${periodLabel}`;
      finalType = 'warning';
    } else {
      finalMsg  = `완료! ${matched}건 저장${skipDetail ? ` / ${skipDetail}` : ''}${noMatch > 0 ? ` / 영수증 미매칭 스킵 ${noMatch}건` : ''}${periodLabel}`;
      finalType = 'success';
    }

    Toast.update(progress, finalMsg, finalType);
    Toast.dismiss(progress, finalType === 'success' ? 4000 : 0);

  } catch (err) {
    console.error('[WM] 치명적 오류:', err);
    const errMsg = '예상치 못한 오류가 발생했습니다. F12 콘솔에서 [WM] 로그를 확인하세요.';
    Toast.update(progress, errMsg, 'error');
    Toast.dismiss(progress, 0);
    chrome.runtime.sendMessage({
      action: 'STATUS_UPDATE', text: errMsg, statusType: 'error',
    }).catch(() => {});
  } finally {
    _isRunning = false;
    // 팝업 상태 표시줄은 Toast._relay()가 이미 처리하므로 별도 전송 불필요
  }
}

// ── 팝업으로부터 메시지 수신 ──────────────────────────────────────────────────
// 중복 주입 시 리스너가 두 번 등록되는 것을 방지한다.

if (!window.__WM_INJECTED__) {
  window.__WM_INJECTED__ = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'START_EXTRACTION') {
      sendResponse({ status: 'started' });
      startExtraction({ selectedCards: msg.selectedCards, dateRange: msg.dateRange });
    }
  });
}
